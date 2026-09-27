import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FlowRequest } from "../src/features/flow/api"
import type { SessionState } from "../src/features/flow/types"
import { canStep, PlaybackBar } from "../src/features/replay/PlaybackBar"
import { ReplayPage } from "../src/features/replay/ReplayPage"
import {
  advancePlayhead, availableStops, initialPlayhead, nudgeSpeed, playheadSeconds, SPEED_STOPS, speedLabel,
  type Playhead, type PlayheadObservation,
} from "../src/features/replay/tickClock"
import {
  rememberSpeed, replayKeyRequest, useReplayKeys, type ReplayKeyContext, type SentSpeed,
} from "../src/features/replay/useReplayKeys"

const ALL_SPEEDS = [2.4, 4.8, 12, 15, 30, 60, 150, 300, 600]

function session(over: Partial<SessionState> = {}): SessionState {
  return {
    status: "paused", error: null, updated_at: "", scenario: null, seed: 1, speed: 12, speeds: ALL_SPEEDS,
    step_seconds: 25, tick_minutes: 5, tick_index: 3, tick_count: 10, start: {}, tick: null, homes: [], orders: {},
    zones: {}, charging_mw: 0, provenance: null, alerts: [], grid_down_zones: [], history: [], totals: null, log: [],
    honest_limits: [], ...over,
  } as SessionState
}

describe("speed stops", () => {
  it("labels each stop, slowest first, by what the viewer experiences for 5-minute ticks", () => {
    expect(SPEED_STOPS.map((stop) => stop.x)).toEqual([2.4, 4.8, 12, 30, 60, 300])
    expect(SPEED_STOPS.map((stop) => speedLabel(stop.x, 5))).toEqual([
      "Real time · about 2 min per tick",
      "2× · about 1 min per tick",
      "5× · about 25 s per tick",
      "about 10 s per tick",
      "about 5 s per tick",
      "Time-lapse · 1 s per tick",
    ])
  })

  it("computes the seconds from tick_minutes instead of hard-coding them", () => {
    expect(speedLabel(300, 10)).toBe("Time-lapse · 2 s per tick")
    expect(speedLabel(60, 10)).toBe("about 10 s per tick")
    // At 10-minute ticks 4.8 is real time: the 125 s order window at true speed.
    expect(speedLabel(4.8, 10)).toBe("Real time · about 2 min per tick")
  })

  it("labels a speed that is not a stop by its pace alone", () => {
    expect(speedLabel(15, 5)).toBe("about 20 s per tick")
  })

  it("skips stops the session does not offer", () => {
    expect(availableStops([15, 60, 300]).map((stop) => stop.x)).toEqual([60, 300])
    expect(availableStops(ALL_SPEEDS).map((stop) => stop.x)).toEqual([2.4, 4.8, 12, 30, 60, 300])
    expect(availableStops(undefined)).toEqual([])
  })

  it("moves one offered stop slower or faster, and stops at the ends", () => {
    expect(nudgeSpeed(12, ALL_SPEEDS, -1)).toBe(4.8)
    expect(nudgeSpeed(12, ALL_SPEEDS, 1)).toBe(30)
    expect(nudgeSpeed(2.4, ALL_SPEEDS, -1)).toBeNull()
    expect(nudgeSpeed(300, ALL_SPEEDS, 1)).toBeNull()
    expect(nudgeSpeed(60, [15, 60, 300], -1)).toBeNull()
    // From a speed that is not a stop: the nearest stop in that direction.
    expect(nudgeSpeed(15, ALL_SPEEDS, -1)).toBe(12)
    expect(nudgeSpeed(15, ALL_SPEEDS, 1)).toBe(30)
  })
})

describe("playback bar speed slider", () => {
  it("is a native range over the offered stops with the current stop as its label", () => {
    const html = renderToStaticMarkup(createElement(PlaybackBar, { state: session(), tSeconds: 0, onSend: () => {} }))
    expect(html).toContain('type="range"')
    expect(html).toContain('min="0"')
    expect(html).toContain('max="5"')
    expect(html).toContain('value="2"')
    expect(html).toContain('aria-valuetext="5× · about 25 s per tick"')
    expect(html).toContain("5× · about 25 s per tick")
    expect(html).not.toContain("Watch orders")
  })

  it("skips stops the session does not offer", () => {
    const html = renderToStaticMarkup(createElement(PlaybackBar, {
      state: session({ speeds: [15, 60, 300], speed: 300 }), tSeconds: 0, onSend: () => {},
    }))
    expect(html).toContain('max="1"')
    expect(html).toContain('value="1"')
    expect(html).toContain('aria-valuetext="Time-lapse · 1 s per tick"')
  })

  it("is disabled with a plain reason when speeds are unavailable", () => {
    const failed = renderToStaticMarkup(createElement(PlaybackBar, { state: session(), tSeconds: 0, speedsAvailable: false, onSend: () => {} }))
    expect(failed).toMatch(/<input[^>]*type="range"[^>]*disabled=""/)
    expect(failed).toContain("Speed unavailable: the scenario list did not load.")
    const none = renderToStaticMarkup(createElement(PlaybackBar, { state: session({ speeds: [15, 150, 600] }), tSeconds: 0, onSend: () => {} }))
    expect(none).toMatch(/<input[^>]*type="range"[^>]*disabled=""/)
    expect(none).toContain("Speed unavailable: this session offers none of these speeds.")
  })

  it("shows the keyboard shortcuts in a Keys hint and in the button titles", () => {
    const html = renderToStaticMarkup(createElement(PlaybackBar, { state: session(), tSeconds: 0, onSend: () => {} }))
    expect(html).toContain("Keys")
    expect(html).toContain('title="Play (Space)"')
    expect(html).toContain('title="Next tick (.)"')
    expect(html).toContain("[ slower")
    expect(html).toContain("] faster")
  })
})

describe("next tick button", () => {
  it("is enabled only while paused before the last tick", () => {
    expect(canStep(session())).toBe(true)
    expect(canStep(session({ status: "playing" }))).toBe(false)
    expect(canStep(session({ tick_index: 10, tick_count: 10 }))).toBe(false)
    expect(canStep(session({ status: "finished", tick_index: 10 }))).toBe(false)
    expect(canStep(session({ status: "idle" }))).toBe(false)
    expect(canStep(null)).toBe(false)
  })

  it("renders disabled while playing and sends a step when paused", () => {
    const playing = renderToStaticMarkup(createElement(PlaybackBar, { state: session({ status: "playing" }), tSeconds: 0, onSend: () => {} }))
    expect(playing).toMatch(/<button[^>]*disabled=""[^>]*>Next tick<\/button>/)
    const paused = renderToStaticMarkup(createElement(PlaybackBar, { state: session(), tSeconds: 0, onSend: () => {} }))
    expect(paused).not.toMatch(/<button[^>]*disabled=""[^>]*>Next tick<\/button>/)
  })
})

describe("keyboard shortcuts", () => {
  const paused: ReplayKeyContext = { status: "paused", speed: 12, speeds: ALL_SPEEDS, canStep: true }
  const body = document.body

  function key(k: string, target: EventTarget | null = body, extra: Partial<KeyboardEvent> = {}) {
    return { key: k, target, ctrlKey: false, metaKey: false, altKey: false, ...extra }
  }

  it("maps Space, [, ] and . to playback requests", () => {
    expect(replayKeyRequest(key(" "), paused)).toEqual({ kind: "play", body: { playing: true } })
    expect(replayKeyRequest(key(" "), { ...paused, status: "playing" })).toEqual({ kind: "play", body: { playing: false } })
    expect(replayKeyRequest(key("["), paused)).toEqual({ kind: "speed", body: { x: 4.8 } })
    expect(replayKeyRequest(key("]"), paused)).toEqual({ kind: "speed", body: { x: 30 } })
    expect(replayKeyRequest(key("."), paused)).toEqual({ kind: "step", body: {} })
  })

  it("does nothing when the action is not available", () => {
    expect(replayKeyRequest(key("."), { ...paused, canStep: false })).toBeNull()
    expect(replayKeyRequest(key("["), { ...paused, speed: 2.4 })).toBeNull()
    expect(replayKeyRequest(key(" "), { ...paused, status: null })).toBeNull()
    expect(replayKeyRequest(key(" "), { ...paused, status: "idle" })).toBeNull()
    expect(replayKeyRequest(key("x"), paused)).toBeNull()
    expect(replayKeyRequest(key("]", body, { metaKey: true }), paused)).toBeNull()
  })

  it("ignores keys typed into an input, textarea, select or editable text", () => {
    for (const tag of ["input", "textarea", "select"]) {
      const el = document.createElement(tag)
      expect(replayKeyRequest(key(" ", el), paused)).toBeNull()
      expect(replayKeyRequest(key("]", el), paused)).toBeNull()
    }
    const editable = document.createElement("div")
    editable.contentEditable = "true"
    Object.defineProperty(editable, "isContentEditable", { value: true })
    expect(replayKeyRequest(key(".", editable), paused)).toBeNull()
  })

  it("leaves Space on a focused button to the button itself", () => {
    const button = document.createElement("button")
    expect(replayKeyRequest(key(" ", button), paused)).toBeNull()
    expect(replayKeyRequest(key("]", button), paused)).toEqual({ kind: "speed", body: { x: 30 } })
  })

  it("keeps working after a click on the speed slider or a checkbox, which are not typing", () => {
    const range = document.createElement("input")
    range.type = "range"
    expect(replayKeyRequest(key(" ", range), paused)).toEqual({ kind: "play", body: { playing: true } })
    expect(replayKeyRequest(key("]", range), paused)).toEqual({ kind: "speed", body: { x: 30 } })
    expect(replayKeyRequest(key(".", range), paused)).toEqual({ kind: "step", body: {} })
    for (const type of ["checkbox", "radio", "button", "submit"]) {
      const el = document.createElement("input")
      el.type = type
      expect(replayKeyRequest(key("[", el), paused)).toEqual({ kind: "speed", body: { x: 4.8 } })
      // Space toggles or presses these by itself.
      expect(replayKeyRequest(key(" ", el), paused)).toBeNull()
    }
    const text = document.createElement("input")
    text.type = "search"
    expect(replayKeyRequest(key("]", text), paused)).toBeNull()
  })

  it("ignores key auto-repeat for [ and ]", () => {
    expect(replayKeyRequest(key("]", body, { repeat: true }), paused)).toBeNull()
    expect(replayKeyRequest(key("[", body, { repeat: true }), paused)).toBeNull()
  })

  it("nudges from the speed last sent while the session still reports the old one", () => {
    const sent = { current: { x: 30, from: 12, atMs: 1_000 } }
    // Second ] before the next poll: 30 -> 60, not 12 -> 30 again.
    expect(replayKeyRequest(key("]"), { ...paused, sent }, 1_500)).toEqual({ kind: "speed", body: { x: 60 } })
    // Once the session reports a new speed, that wins.
    expect(replayKeyRequest(key("]"), { ...paused, speed: 30, sent }, 1_500)).toEqual({ kind: "speed", body: { x: 60 } })
    expect(replayKeyRequest(key("]"), { ...paused, speed: 60, sent }, 1_500)).toEqual({ kind: "speed", body: { x: 300 } })
    // A send the session never took is forgotten after a while.
    expect(replayKeyRequest(key("]"), { ...paused, sent }, 10_000)).toEqual({ kind: "speed", body: { x: 30 } })
  })

  it("remembers each speed sent, with the speed the session reported at the time", () => {
    const sent: { current: SentSpeed | null } = { current: null }
    rememberSpeed(sent, { kind: "play", body: { playing: true } }, 12, 0)
    expect(sent.current).toBeNull()
    rememberSpeed(sent, { kind: "speed", body: { x: 30 } }, 12, 100)
    expect(sent.current).toEqual({ x: 30, from: 12, atMs: 100 })
    rememberSpeed(sent, { kind: "speed", body: { x: 60 } }, 12, 200)
    expect(sent.current).toEqual({ x: 60, from: 12, atMs: 200 })
  })

  describe("on the page", () => {
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

    function Host({ onRequest }: { onRequest: (request: FlowRequest) => void }) {
      useReplayKeys(paused, onRequest)
      return createElement("input", { "aria-label": "Search" })
    }

    it("sends the request and stops Space from scrolling, but not while typing", () => {
      const onRequest = vi.fn()
      act(() => root.render(createElement(Host, { onRequest })))
      const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })
      act(() => { window.dispatchEvent(space) })
      expect(onRequest).toHaveBeenCalledWith({ kind: "play", body: { playing: true } })
      expect(space.defaultPrevented).toBe(true)
      onRequest.mockClear()
      const input = host.querySelector("input")!
      act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })) })
      expect(onRequest).not.toHaveBeenCalled()
    })
  })
})

describe("playhead", () => {
  const observe = (p: Playhead, nowMs: number, tickIndex: number, stepSeconds: number, playing = true,
    extra: Partial<PlayheadObservation> = {}) =>
    advancePlayhead(p, { nowMs, tickIndex, stepSeconds, playing, ...extra })

  it("plays the last tick's window once and holds at 2:00 when the scenario finishes", () => {
    let p = observe(initialPlayhead(0), 0, 143, 25)
    p = observe(p, 25_000, 144, 25, false, { finished: true })
    expect(playheadSeconds(p, 25_000)).toBe(0)
    expect(playheadSeconds(p, 35_000)).toBe(50)
    expect(playheadSeconds(p, 90_000)).toBe(120)
    // Same from a worker that publishes the time left: a finished tick has none.
    let q = observe(initialPlayhead(0), 0, 143, 25)
    q = observe(q, 25_000, 144, 25, false, { finished: true, tickLeft: null })
    expect(playheadSeconds(q, 35_000)).toBe(50)
  })

  it("opens mid-tick where the worker says the tick is, playing or paused", () => {
    const playing = observe(initialPlayhead(0), 0, 3, 25, true, { tickLeft: 20 })
    expect(playheadSeconds(playing, 0)).toBe(25)
    expect(playheadSeconds(playing, 10_000)).toBe(75)
    let paused = observe(initialPlayhead(0), 0, 3, 25, false, { tickLeft: 12.5 })
    expect(playheadSeconds(paused, 0)).toBe(62.5)
    expect(playheadSeconds(paused, 60_000)).toBe(62.5)
    // Play then resumes from there, not from 2:00.
    paused = observe(paused, 60_000, 3, 25, true, { tickLeft: 12.5 })
    expect(playheadSeconds(paused, 60_000)).toBe(62.5)
    expect(playheadSeconds(paused, 72_500)).toBe(125)
  })

  it("leaves 2:00 on Play once the worker says how much of the tick is left", () => {
    // Opened while paused after a Next tick: nothing is frozen, so the head rests at 2:00.
    let p = observe(initialPlayhead(0), 0, 3, 25, false, { tickLeft: null })
    expect(playheadSeconds(p, 1_000)).toBe(120)
    p = observe(p, 5_000, 3, 25, true, { tickLeft: 10 })
    expect(playheadSeconds(p, 5_000)).toBe(75)
    expect(playheadSeconds(p, 15_000)).toBe(125)
  })

  it("plays a tick stepped right after a pause as a step, since the worker keeps no remainder for it", () => {
    // Space then . within one page poll: the page sees the next tick, paused, while it was playing.
    let p = observe(initialPlayhead(0), 0, 3, 25)
    p = observe(p, 10_000, 4, 25, false, { tickLeft: null })
    expect(playheadSeconds(p, 10_000)).toBe(0)
    expect(playheadSeconds(p, 20_000)).toBe(50)
    expect(playheadSeconds(p, 60_000)).toBe(120)
  })

  it("freezes a tick that played just before a pause where the worker's remainder puts it", () => {
    let p = observe(initialPlayhead(0), 0, 3, 25)
    p = observe(p, 26_000, 4, 25, false, { tickLeft: 24 })
    expect(playheadSeconds(p, 26_000)).toBe(5)
    expect(playheadSeconds(p, 40_000)).toBe(5)
  })

  it("plays each tick's 125 s window across one step while playing", () => {
    const p = observe(initialPlayhead(0), 0, 3, 25)
    expect(playheadSeconds(p, 0)).toBe(0)
    expect(playheadSeconds(p, 12_500)).toBe(62.5)
    expect(playheadSeconds(p, 40_000)).toBe(125)
  })

  it("keeps the playhead monotonic when the speed changes mid-tick", () => {
    let p = observe(initialPlayhead(0), 0, 3, 25)
    const samples: number[] = []
    for (let ms = 0; ms <= 12_500; ms += 250) samples.push(playheadSeconds(p, ms))
    // Faster: 1 s per tick from halfway. The rest of the window takes 0.5 s.
    p = observe(p, 12_500, 3, 1)
    for (let ms = 12_500; ms <= 13_500; ms += 100) samples.push(playheadSeconds(p, ms))
    for (let i = 1; i < samples.length; i += 1) expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1])
    expect(playheadSeconds(p, 12_500)).toBe(62.5)
    expect(playheadSeconds(p, 13_000)).toBe(125)
  })

  it("slows down from where it is instead of jumping back", () => {
    let p = observe(initialPlayhead(0), 0, 3, 25)
    p = observe(p, 12_500, 3, 125)
    expect(playheadSeconds(p, 12_500)).toBe(62.5)
    expect(playheadSeconds(p, 12_500 + 31_250)).toBe(93.75)
    expect(playheadSeconds(p, 12_500 + 62_500)).toBe(125)
  })

  it("after a step while paused, plays that tick's window once and then holds at 2:00", () => {
    let p = observe(initialPlayhead(0), 0, 3, 25, false)
    expect(playheadSeconds(p, 5_000)).toBe(120)
    p = observe(p, 10_000, 4, 25, false)
    expect(playheadSeconds(p, 10_000)).toBe(0)
    expect(playheadSeconds(p, 20_000)).toBe(50)
    expect(playheadSeconds(p, 34_000)).toBe(120)
    expect(playheadSeconds(p, 90_000)).toBe(120)
  })

  it("freezes where it is when paused mid-tick", () => {
    let p = observe(initialPlayhead(0), 0, 3, 25)
    p = observe(p, 12_500, 3, 25, false)
    expect(playheadSeconds(p, 12_500)).toBe(62.5)
    expect(playheadSeconds(p, 60_000)).toBe(62.5)
    // A speed change while frozen keeps the frozen position.
    p = observe(p, 70_000, 3, 1, false)
    expect(playheadSeconds(p, 71_000)).toBe(62.5)
  })

  it("resumes from the frozen position on play, without skipping the paused time", () => {
    let p = observe(initialPlayhead(0), 0, 3, 25)
    p = observe(p, 12_500, 3, 25, false)
    p = observe(p, 72_500, 3, 25, true)
    expect(playheadSeconds(p, 72_500)).toBe(62.5)
    expect(playheadSeconds(p, 72_500 + 6_250)).toBe(93.75)
    expect(playheadSeconds(p, 72_500 + 12_500)).toBe(125)
  })

  it("freezes at the start of a tick that arrived just before a pause, instead of playing it as a step", () => {
    let p = observe(initialPlayhead(0), 0, 3, 25)
    p = observe(p, 25_000, 4, 25, false)
    expect(playheadSeconds(p, 25_000)).toBe(0)
    expect(playheadSeconds(p, 40_000)).toBe(0)
  })

  it("holds at 2:00 after a reset while paused", () => {
    let p = observe(initialPlayhead(0), 0, 3, 25)
    p = observe(p, 6_000, 0, 25, false)
    expect(playheadSeconds(p, 7_000)).toBe(120)
  })

  it("does not cut a stepped tick short when play is pressed during it", () => {
    let p = observe(initialPlayhead(0), 0, 3, 25, false)
    p = observe(p, 10_000, 4, 25, false)
    expect(playheadSeconds(p, 20_000)).toBe(50)
    p = observe(p, 20_000, 4, 25, true)
    expect(playheadSeconds(p, 20_000)).toBe(50)
    expect(playheadSeconds(p, 20_000 + 12_500)).toBe(112.5)
    // The worker's next tick is due 25 s after the step (35 s): the head reaches the end of the window then.
    expect(playheadSeconds(p, 35_000)).toBe(125)
  })

  it("treats two steps landing in one poll as a step, not a jump to 2:00", () => {
    let p = observe(initialPlayhead(0), 0, 3, 25, false)
    p = observe(p, 10_000, 5, 25, false)
    expect(playheadSeconds(p, 10_000)).toBe(0)
    expect(playheadSeconds(p, 20_000)).toBe(50)
  })
})

describe("replay page playhead", () => {
  it("uses the playhead the root computed when one is given", () => {
    const html = renderToStaticMarkup(createElement(ReplayPage, {
      scenarios: null, state: session({ status: "playing" }), nowMs: 0, playheadT: 62.5,
    }))
    expect(html).toContain("1:02")
  })
})
