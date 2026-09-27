// Task 14B: the Day view wired into Replay, seek (Task 16B), pause freezing the lines, the line legend and the
// scenario-switch reset. Fixtures are the real engine runs in fixtures/day14.ts (see its header).
import replayCss from "../src/features/replay/replay.css?raw"
import zoneCss from "../src/features/replay/zone.css?raw"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { sendRequest, type FlowRequest } from "../src/features/flow/api"
import type { FlowHome, SessionState } from "../src/features/flow/types"
import { DayBar } from "../src/features/replay/DayBar"
import {
  DAY_STOPS, canSeek, dayStops, dayWindow, emptyArrivals, observedSecondsPerTick, ordersViewSpeed, runKey, seekBy,
  seekClock, seekIndexAt, settleSeek, ticksPerHour, trackArrivals, viewPlaySpeed,
} from "../src/features/replay/dayModel"
import { LINE_KINDS } from "../src/features/replay/LineLegend"
import { MapStage } from "../src/features/replay/MapStage"
import { PlaybackBar } from "../src/features/replay/PlaybackBar"
import { ReplayPage } from "../src/features/replay/ReplayPage"
import { SESSION_SPEEDS, SPEED_STOPS, availableStops, nudgeSpeed } from "../src/features/replay/tickClock"
import { replayKeyRequest, type ReplayKeyContext } from "../src/features/replay/useReplayKeys"
import { beryl, heatherFreeze, operatorHold, stormHigh, stormNight } from "./fixtures/day14"

const ALL_SPEEDS = [2.4, 4.8, 12, 15, 30, 60, 150, 288, 300, 600, 720, 1440]

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
    seed: 42, tick_index: 22, tick_count: beryl.tick_count, tick: beryl.tick22, history: beryl.history,
    alerts: beryl.alerts, provenance: beryl.provenance22, counties: beryl.counties, ...over,
  })
}

function holdSession(over: Record<string, unknown> = {}): SessionState {
  return session({
    scenario: { id: "operator-hold", name: "Operator hold", alerts: [], first_ts: operatorHold.first_ts, last_ts: operatorHold.last_ts },
    seed: 1, tick_index: 25, tick_count: operatorHold.tick_count, tick: { tick: 25, ts: operatorHold.history.at(-1)!.ts },
    history: operatorHold.history, ...over,
  })
}

const at = (ts: string) => Date.parse(ts)

describe("tickClock day speeds", () => {
  it("knows the Day view speeds, and stops default to the Watch orders stops", () => {
    expect(SESSION_SPEEDS).toEqual([2.4, 4.8, 12, 15, 30, 60, 150, 288, 300, 600, 720, 1440])
    expect(availableStops(ALL_SPEEDS).map((stop) => stop.x)).toEqual(SPEED_STOPS.map((stop) => stop.x))
    expect(availableStops(ALL_SPEEDS, DAY_STOPS).map((stop) => stop.x)).toEqual([288, 720, 1440])
    expect(nudgeSpeed(288, ALL_SPEEDS, 1, DAY_STOPS)).toBe(720)
    expect(nudgeSpeed(1440, ALL_SPEEDS, 1, DAY_STOPS)).toBeNull()
    expect(nudgeSpeed(12, ALL_SPEEDS, 1)).toBe(30)
  })
})

describe("seek helpers", () => {
  const win = dayWindow(berylSession())!

  it("counts ticks per hour from the session's tick length", () => {
    expect(ticksPerHour(5)).toBe(12)
    expect(ticksPerHour(15)).toBe(4)
  })

  it("maps a time on the bar to the tick index whose tick sits there, snapped to the nearest tick", () => {
    // The first frame (22:00) is tick index 1; frame p is tick index p + 1.
    expect(seekIndexAt(win, win.startMs, 5, 193)).toBe(1)
    expect(seekIndexAt(win, at("2024-07-08T06:00:00-05:00"), 5, 193)).toBe(97)
    expect(seekIndexAt(win, at("2024-07-08T06:02:00-05:00"), 5, 193)).toBe(97)
    expect(seekIndexAt(win, at("2024-07-08T06:03:00-05:00"), 5, 193)).toBe(98)
    // The worker seeks within [0, tick_count - 1].
    expect(seekIndexAt(win, win.endMs, 5, 193)).toBe(192)
    expect(seekIndexAt(win, win.endMs + 3_600_000, 5, 193)).toBe(192)
  })

  it("names the landing tick's local time", () => {
    expect(seekClock(win, 97, 5)).toBe("06:00")
    expect(seekClock(win, 1, 5)).toBe("22:00")
    expect(seekClock(win, 0, 5)).toBe("22:00")
  })

  it("seeks back and forward by whole ticks, inside the worker's range, and never to where it is", () => {
    const state = berylSession()
    expect(seekBy(state, -12)).toEqual({ kind: "seek", body: { tick: 10 } })
    expect(seekBy(state, 12)).toEqual({ kind: "seek", body: { tick: 34 } })
    expect(seekBy(berylSession({ tick_index: 5 }), -12)).toEqual({ kind: "seek", body: { tick: 0 } })
    expect(seekBy(berylSession({ tick_index: 190 }), 12)).toEqual({ kind: "seek", body: { tick: 192 } })
    expect(seekBy(berylSession({ tick_index: 192 }), 12)).toBeNull()
    expect(seekBy(berylSession({ tick_index: 0 }), -1)).toBeNull()
  })

  it("seeks only with a scenario loaded and no seek running", () => {
    expect(canSeek(berylSession())).toBe(true)
    expect(canSeek(berylSession({ status: "playing" }))).toBe(true)
    expect(canSeek(berylSession({ status: "finished", tick_index: 193 }))).toBe(true)
    expect(canSeek(berylSession({ seeking: true }))).toBe(false)
    expect(canSeek(session({ status: "idle" }))).toBe(false)
    expect(canSeek(null)).toBe(false)
    expect(seekBy(berylSession({ seeking: true }), 12)).toBeNull()
  })

  it("holds the Seeking state until the worker lands on the target, then lets go", () => {
    const pending = { tick: 97, label: "06:00", atMs: 0, key: "beryl-landfall|42", sawSeeking: false }
    const obs = (over: Record<string, unknown>) => ({ seeking: false, tickIndex: 22, key: "beryl-landfall|42", ...over })
    // Not picked up yet: keep it.
    expect(settleSeek(pending, obs({}), 500)).toEqual(pending)
    // The worker says it is seeking (old tick flagged): keep it, and remember that it saw it.
    const seen = settleSeek(pending, obs({ seeking: true }), 800)
    expect(seen).toMatchObject({ tick: 97, sawSeeking: true })
    // Landed on tick N first (the 16A contract), or done seeking: let go.
    expect(settleSeek(pending, obs({ tickIndex: 97 }), 900)).toBeNull()
    expect(settleSeek(seen, obs({ tickIndex: 98 }), 1200)).toBeNull()
    // A scenario switch or a worker that never answers lets go too.
    expect(settleSeek(pending, obs({ key: "operator-hold|1" }), 900)).toBeNull()
    expect(settleSeek(pending, obs({}), 20_000)).toBeNull()
    expect(settleSeek(null, obs({}), 0)).toBeNull()
  })
})

describe("Day view keys", () => {
  const ctx = (over: Partial<ReplayKeyContext> = {}): ReplayKeyContext => ({
    status: "playing", speed: 1440, speeds: ALL_SPEEDS, canStep: false, stops: dayStops(ALL_SPEEDS),
    tickIndex: 22, tickCount: 193, tickMinutes: 5, canSeek: true, ...over,
  })
  const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, target: null, ...extra })

  it("nudges within the day stops in Day view, and within the Watch orders stops there", () => {
    expect(replayKeyRequest(key("["), ctx({ speed: 1440 }), 0)).toEqual({ kind: "speed", body: { x: 720 } })
    expect(replayKeyRequest(key("]"), ctx({ speed: 288 }), 0)).toEqual({ kind: "speed", body: { x: 720 } })
    expect(replayKeyRequest(key("]"), ctx({ speed: 1440 }), 0)).toBeNull()
    expect(replayKeyRequest(key("]"), ctx({ speed: 12, stops: SPEED_STOPS }), 0)).toEqual({ kind: "speed", body: { x: 30 } })
  })

  it("seeks one tick with , and . and one hour with Shift", () => {
    expect(replayKeyRequest(key(","), ctx(), 0)).toEqual({ kind: "seek", body: { tick: 21 } })
    expect(replayKeyRequest(key("."), ctx(), 0)).toEqual({ kind: "seek", body: { tick: 23 } })
    expect(replayKeyRequest(key("<", { shiftKey: true }), ctx(), 0)).toEqual({ kind: "seek", body: { tick: 10 } })
    expect(replayKeyRequest(key(">", { shiftKey: true }), ctx(), 0)).toEqual({ kind: "seek", body: { tick: 34 } })
    // Layouts where Shift keeps the , and . key names.
    expect(replayKeyRequest(key(",", { shiftKey: true }), ctx(), 0)).toEqual({ kind: "seek", body: { tick: 10 } })
    expect(replayKeyRequest(key(".", { shiftKey: true }), ctx(), 0)).toEqual({ kind: "seek", body: { tick: 34 } })
  })

  it("keeps . as Next tick while paused", () => {
    expect(replayKeyRequest(key("."), ctx({ status: "paused", canStep: true }), 0)).toEqual({ kind: "step", body: {} })
  })

  it("sends no seek while one is running, on key repeat, or at the ends", () => {
    expect(replayKeyRequest(key(","), ctx({ canSeek: false }), 0)).toBeNull()
    expect(replayKeyRequest(key(",", { repeat: true }), ctx(), 0)).toBeNull()
    expect(replayKeyRequest(key(","), ctx({ tickIndex: 0 }), 0)).toBeNull()
    expect(replayKeyRequest(key("."), ctx({ tickIndex: 192 }), 0)).toBeNull()
  })
})

describe("seek request", () => {
  it("posts the tick index to /v1/scenario/seek", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 202 }))
    await sendRequest(fetchFn as unknown as typeof fetch, "", { kind: "seek", body: { tick: 97 } })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/v1/scenario/seek")
    expect(JSON.parse(String(init.body))).toEqual({ tick: 97 })
  })
})

describe("view and speed coupling", () => {
  it("Day view asks for the default day stop on Play or Start when the speed is not a day stop", () => {
    const play: FlowRequest = { kind: "play", body: { playing: true } }
    expect(viewPlaySpeed("day", play, berylSession({ speed: 12 }))).toBe(1440)
    expect(viewPlaySpeed("day", { kind: "start", body: { scenario: "faults" } }, berylSession({ speed: 60 }))).toBe(1440)
    expect(viewPlaySpeed("day", play, berylSession({ speed: 720 }))).toBeNull()
    expect(viewPlaySpeed("day", { kind: "play", body: { playing: false } }, berylSession({ speed: 12 }))).toBeNull()
    expect(viewPlaySpeed("orders", play, berylSession({ speed: 12 }))).toBeNull()
    // A worker without the day stops gets its fastest real speed.
    expect(viewPlaySpeed("day", play, berylSession({ speed: 12, speeds: [2.4, 12, 600] }))).toBe(600)
  })

  it("Watch orders asks for 12 when the speed is above 60", () => {
    expect(ordersViewSpeed(berylSession({ speed: 1440 }))).toBe(12)
    expect(ordersViewSpeed(berylSession({ speed: 60 }))).toBeNull()
    expect(ordersViewSpeed(berylSession({ speed: 1440, speeds: [60, 1440] }))).toBeNull()
    expect(ordersViewSpeed(null)).toBeNull()
  })
})

describe("scenario switch", () => {
  it("names the run by scenario and seed", () => {
    expect(runKey(berylSession())).toBe("beryl-landfall|42")
    expect(runKey(holdSession())).toBe("operator-hold|1")
    expect(runKey(session())).toBeNull()
  })

  it("forgets the measured pace on a new run, a rewind, a pause or a speed change", () => {
    const obs = (tickIndex: number, atMs: number, over: Record<string, unknown> = {}) =>
      ({ key: "beryl-landfall|42", tickIndex, playing: true, speed: 1440, atMs, ...over })
    let track = emptyArrivals()
    for (let i = 0; i < 4; i += 1) track = trackArrivals(track, obs(10 + i, i * 250))
    expect(observedSecondsPerTick(track.list)).toBeCloseTo(0.25)
    expect(trackArrivals(track, obs(14, 1000, { key: "operator-hold|1" })).list).toHaveLength(1)
    expect(trackArrivals(track, obs(3, 1000)).list).toHaveLength(1)
    expect(trackArrivals(track, obs(14, 1000, { playing: false })).list).toHaveLength(0)
    expect(trackArrivals(track, obs(14, 1000, { speed: 720 })).list).toHaveLength(1)
    // The same tick seen twice is one arrival.
    expect(trackArrivals(track, obs(13, 1000)).list).toHaveLength(4)
  })

  it("redraws the Day bar's window, marks and playhead for the new scenario", () => {
    const page = (state: SessionState, playheadMs: number | null) => renderToStaticMarkup(createElement(ReplayPage, {
      scenarios: null, state, nowMs: 0, view: "day", dayPlayheadMs: playheadMs,
    } as never))
    const before = page(berylSession(), at("2024-07-07T23:45:00-05:00"))
    expect(before).toContain("Scenario day, 22:00 to 14:00 CDT")
    expect(before).toContain("NWS Tropical Storm Warning")
    const after = page(holdSession(), null)
    expect(after).toContain("Scenario day, 16:30 to 21:30 CDT")
    expect(after).not.toContain("Tropical Storm")
    expect(before).not.toContain("Operator HOLD: no orders")
    expect(after).toContain("Operator HOLD: no orders")
    expect(after).toContain(`Tick 25 of 61`)
  })
})

describe("PlaybackBar views", () => {
  const bar = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(PlaybackBar, {
    state: berylSession(), tSeconds: 120, onSend: () => {}, ...props,
  } as never))

  it("Day view shows the day bar, not the order window", () => {
    const html = bar({ view: "day", dayPlayheadMs: at("2024-07-07T23:45:00-05:00") })
    expect(html).not.toContain("0:00 send")
    expect(html).not.toContain("2:00 books close")
    expect(html).toContain("Tick 22 of 193 · Jul 7, 2024 23:45 CDT")
    expect(html).toContain("22:00 CDT")
    expect(html).toMatch(/aria-pressed="true"[^>]*>1 min per day</)
    expect(html).not.toContain('aria-label="Speed"')
  })

  it("Day view shows Next tick only while paused", () => {
    expect(bar({ view: "day", state: berylSession({ status: "paused" }) })).toContain("Next tick")
    expect(bar({ view: "day", state: berylSession({ status: "playing" }) })).not.toContain("Next tick")
  })

  it("Day view has Back 1 hour and Forward 1 hour buttons", () => {
    const html = bar({ view: "day" })
    expect(html).toMatch(/<button[^>]*aria-label="Back 1 hour"/)
    expect(html).toMatch(/<button[^>]*aria-label="Forward 1 hour"/)
    expect(html).not.toMatch(/<button[^>]*aria-label="Back 1 hour"[^>]*disabled=""/)
  })

  it("while seeking, says where to and disables the seek controls", () => {
    const html = bar({ view: "day", seek: { busy: true, label: "06:00" } })
    expect(html).toContain("Seeking to 06:00…")
    expect(html).toMatch(/<button[^>]*aria-label="Back 1 hour"[^>]*disabled=""/)
    expect(html).toMatch(/<button[^>]*aria-label="Forward 1 hour"[^>]*disabled=""/)
    expect(html).toContain("replay-day-track is-seeking")
    // Another viewer's seek: the worker says seeking, with no target known here.
    expect(bar({ view: "day", state: berylSession({ seeking: true }) })).toContain("Seeking…")
  })

  it("Watch orders keeps the order window and the speed slider", () => {
    const html = bar({ view: "orders" })
    expect(html).toContain("0:00 send")
    expect(html).toContain("2:00 books close")
    expect(html).toContain('aria-label="Speed"')
    expect(html).not.toContain("min per day")
    expect(bar({})).toContain("2:00 books close")
  })

  it("offers the view toggle with the current view pressed", () => {
    const html = bar({ view: "day", onView: () => {} })
    expect(html).toMatch(/aria-pressed="true"[^>]*>Day view</)
    expect(html).toMatch(/aria-pressed="false"[^>]*>Watch orders</)
  })

  it("reads the tick length from the session", () => {
    expect(bar({ view: "orders", state: berylSession({ tick_minutes: 10 }) })).toContain("Each tick is 10 minutes")
  })

  it("names the seek keys in the keys hint", () => {
    for (const view of ["day", "orders"]) {
      const html = bar({ view })
      expect(html).toContain(", back a tick")
      expect(html).toContain(". forward a tick")
      expect(html).toContain("Shift+, or Shift+. one hour")
    }
  })
})

describe("Day bar seeking with the pointer", () => {
  let host: HTMLDivElement
  let root: Root

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

  function mount(onSend: (request: FlowRequest) => void, props: Record<string, unknown> = {}) {
    act(() => {
      root.render(createElement(DayBar, { state: berylSession(), unavailable: null, onSend, ...props } as never))
    })
    const track = host.querySelector<HTMLDivElement>(".replay-day-track")!
    track.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 40, right: 1000, bottom: 40, x: 0, y: 0, toJSON: () => ({}) })
    return track
  }
  const fire = (el: Element, type: string, clientX: number) => {
    act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX })) })
  }

  it("previews the time while dragging and sends one seek on release", () => {
    const sent: FlowRequest[] = []
    const track = mount((request) => sent.push(request))
    fire(track, "pointerdown", 200)
    fire(track, "pointermove", 500)
    expect(host.textContent).toContain("Seek to 06:00")
    expect(sent).toEqual([])
    fire(track, "pointerup", 500)
    expect(sent).toEqual([{ kind: "seek", body: { tick: 97 } }])
    expect(host.textContent).not.toContain("Seek to")
  })

  it("does nothing while a seek is running", () => {
    const sent: FlowRequest[] = []
    const track = mount((request) => sent.push(request), { seek: { busy: true, label: "06:00" } })
    fire(track, "pointerdown", 500)
    fire(track, "pointerup", 500)
    expect(sent).toEqual([])
  })

  it("sends Back 1 hour and Forward 1 hour as seeks", () => {
    const sent: FlowRequest[] = []
    mount((request) => sent.push(request))
    act(() => { host.querySelector<HTMLButtonElement>('button[aria-label="Back 1 hour"]')!.click() })
    act(() => { host.querySelector<HTMLButtonElement>('button[aria-label="Forward 1 hour"]')!.click() })
    expect(sent).toEqual([{ kind: "seek", body: { tick: 10 } }, { kind: "seek", body: { tick: 34 } }])
  })

  it("names the pace keys that really work in the preset titles", () => {
    mount(() => {})
    const titles = [...host.querySelectorAll<HTMLButtonElement>(".replay-day-presets button")].map((button) => button.title)
    expect(titles.length).toBe(3)
    // [ and ] move within these presets (useReplayKeys gets the day stops in Day view).
    const ctx: ReplayKeyContext = { status: "playing", speed: 1440, speeds: ALL_SPEEDS, canStep: false, stops: dayStops(ALL_SPEEDS) }
    expect(titles.every((title) => title.includes("[ slower, ] faster"))).toBe(true)
    expect(replayKeyRequest({ key: "[", ctrlKey: false, metaKey: false, altKey: false, target: null }, ctx, 0))
      .toEqual({ kind: "speed", body: { x: 720 } })
  })
})

describe("pause freezes the lines", () => {
  const page = (status: string, zone: string | null = null) => renderToStaticMarkup(createElement(ReplayPage, {
    scenarios: null, state: berylSession({ status }), nowMs: 0, selectedZone: zone,
  } as never))

  it("puts a paused class on the stage root while paused, on the map and the zone board", () => {
    expect(page("paused")).toMatch(/<main class="replay-scene[^"]*is-paused/)
    expect(page("paused", "Houston")).toMatch(/<main class="replay-scene[^"]*is-paused/)
    expect(page("finished")).toMatch(/<main class="replay-scene[^"]*is-paused/)
    expect(page("playing")).not.toContain("is-paused")
  })

  it("stops every line's dash flow off that class", () => {
    const rule = (selector: string) => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{]*\\{[^}]*animation-play-state: paused`)
    expect(replayCss).toMatch(rule(".replay-scene.is-paused .arc-send"))
    expect(replayCss).toMatch(/\.replay-scene\.is-paused \.arc-charge/)
    expect(zoneCss).toMatch(rule(".replay-scene.is-paused .zp.p-out"))
    expect(zoneCss).toMatch(/\.replay-scene\.is-paused \.zp\.p-retry/)
  })
})

describe("line legend", () => {
  const page = (zone: string | null, state: SessionState | null = berylSession()) => renderToStaticMarkup(createElement(ReplayPage, {
    scenarios: null, state, nowMs: 0, selectedZone: zone,
  } as never))

  it("lists every line kind", () => {
    expect(LINE_KINDS.map((kind) => kind.label)).toEqual(["On its way", "Lost", "Gave energy", "Confirmed", "Not counted", "Charging"])
  })

  it("is always shown, on the map and the zone board, with or without a session", () => {
    for (const html of [page(null), page("Houston"), page(null, null), page("West", null)]) {
      expect(html).toContain('class="replay-line-legend"')
      for (const kind of LINE_KINDS) expect(html).toContain(`>${kind.label}</`)
    }
  })

  it("is pinned while scrolling and wraps at narrow widths", () => {
    const css = replayCss
    const block = /\.replay-line-legend \{([^}]*)\}/.exec(css)?.[1] ?? ""
    expect(block).toMatch(/position: sticky/)
    expect(block).toMatch(/top: 0/)
    expect(block).toMatch(/flex-wrap: wrap/)
  })
})

describe("zone board rain gate", () => {
  const homes = ["West", "North", "South", "Houston"].flatMap((zone, z) =>
    Array.from({ length: 2 }, (_, k) => ({ id: `home-${z}${k}`, zone, soc_pct: 70, kw: 0, state: "holding", status: "live", floor_pct: 60 }) as FlowHome))
  const page = (state: SessionState, zone: string) => renderToStaticMarkup(createElement(ReplayPage, {
    scenarios: null, state, nowMs: 0, selectedZone: zone, view: "day",
  } as never))

  it("dims only a zone with a rain county this tick", () => {
    const state = berylSession({ tick: beryl.tick2, provenance: beryl.provenance2, homes })
    expect(page(state, "Houston")).toContain("zone-scene is-weather")
    expect(page(state, "North")).not.toContain("is-weather")
  })

  it("does not dim storm-rule-high zones: the floors rise, but no alert names a county", () => {
    const state = session({ tick: stormHigh.tick26, provenance: stormHigh.provenance26, zones: stormHigh.zones26, homes })
    for (const zone of ["Houston", "North", "South", "West"]) expect(page(state, zone)).not.toContain("is-weather")
  })

  it("does not dim for the Heather freeze", () => {
    const state = session({ tick: heatherFreeze.tick2, provenance: heatherFreeze.provenance2, alerts: heatherFreeze.alerts, zones: heatherFreeze.zones2, homes })
    for (const zone of ["Houston", "North"]) expect(page(state, zone)).not.toContain("is-weather")
  })
})

describe("reduced motion", () => {
  it("turns off the glide, the sun fade and the seek preview", () => {
    const css = replayCss
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n")
    for (const cls of [".replay-sun", ".replay-day-fill", ".replay-day-head"]) expect(reduced).toContain(cls)
    expect(reduced).toMatch(/transition: none/)
  })
})

describe("map sun and county rain", { timeout: 20_000 }, () => {
  let host: HTMLDivElement
  let root: Root

  beforeAll(() => {
    const proto = window.SVGSVGElement?.prototype as unknown as { createSVGRect?: () => unknown } | undefined
    if (proto && !proto.createSVGRect) proto.createSVGRect = () => ({ x: 0, y: 0, width: 0, height: 0 })
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return 1440 } })
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 836 } })
  })
  afterAll(() => {
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

  async function mount(tick: unknown, provenance: unknown, alerts: unknown, zones: unknown = {}) {
    await act(async () => {
      root.render(createElement(MapStage, {
        zones: zones as never, homes: [], tick: tick as never, provenance: provenance as never, alerts: alerts as never,
        baseFloorPct: 30, tSeconds: 120, lens: "send", notice: null, onZone: () => {},
      }))
    })
    for (let i = 0; i < 400 && !host.querySelector(".replay-chip"); i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
    expect(host.querySelector(".replay-chip")).not.toBeNull()
  }
  const fipsOf = (selector: string) => [...host.querySelectorAll<HTMLElement | SVGElement>(selector)].map((el) => el.dataset.fips)
  const nightZones = () => [...host.querySelectorAll<SVGElement>(".replay-sun-night.is-on")].map((el) => el.dataset.zone).sort()

  it("rains over Harris only for Beryl, at night", async () => {
    await mount(beryl.tick2, beryl.provenance2, beryl.alerts)
    expect(fipsOf(".replay-wx-rain")).toEqual(["48201"])
    expect(fipsOf(".replay-wx-clouds")).toEqual(["48201"])
    expect(host.querySelector<HTMLElement>(".replay-wx-rain")?.style.clipPath).toMatch(/^polygon\(/)
    // 22:05 CDT in July: night over all four zones.
    expect(nightZones()).toEqual(["Houston", "North", "South", "West"])
    expect(host.textContent).toContain("Rain: counties an NWS storm alert names this tick")
  })

  it("draws amber floors but no rain for storm-rule-high", async () => {
    await mount(stormHigh.tick26, stormHigh.provenance26, stormHigh.alerts, stormHigh.zones26)
    expect(host.querySelector(".replay-wx-rain")).toBeNull()
    expect(host.querySelector(".replay-wx-clouds")).toBeNull()
    const zones = [...host.querySelectorAll(".replay-zone")]
    expect(zones).toHaveLength(4)
    expect(zones.every((el) => el.classList.contains("is-raised"))).toBe(true)
  })

  it("draws no rain for the Heather freeze", async () => {
    await mount(heatherFreeze.tick2, heatherFreeze.provenance2, heatherFreeze.alerts, heatherFreeze.zones2)
    expect(host.querySelector(".replay-wx-rain")).toBeNull()
  })

  it("stops the flash flood rain after 17:30, in daylight", async () => {
    await mount(stormNight.tick19, stormNight.provenance19, stormNight.alerts)
    expect(fipsOf(".replay-wx-rain").sort()).toEqual(["48135", "48329"])
    expect(nightZones()).toEqual([])
    await mount(stormNight.tick20, stormNight.provenance20, stormNight.alerts)
    expect(host.querySelector(".replay-wx-rain")).toBeNull()
  })

  it("draws no rain and no shading without a tick", async () => {
    await mount(null, null, [])
    expect(host.querySelector(".replay-wx-rain")).toBeNull()
    expect(host.querySelectorAll(".replay-sun.is-on")).toHaveLength(0)
  })
})
