// Task 14B fix round 2: relative seeks while playing, "Seeking" held until the worker answers by seq, the last seekable
// tick at the right end of the Day bar, and poll replies applied in order.
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { sendRequest, type FlowRequest } from "../src/features/flow/api"
import type { SessionState } from "../src/features/flow/types"
import { DayBar } from "../src/features/replay/DayBar"
import {
  dayStops, dayWindow, freshReply, seekBy, seekClock, seekIndexAt, seekLanding, seekMs, settleSeek,
} from "../src/features/replay/dayModel"
import { ReplayRoot } from "../src/features/replay/ReplayRoot"
import { replayKeyRequest, type ReplayKeyContext } from "../src/features/replay/useReplayKeys"
import { beryl } from "./fixtures/day14"

const ALL_SPEEDS = [2.4, 4.8, 12, 15, 30, 60, 150, 288, 300, 600, 720, 1440]

function berylSession(over: Record<string, unknown> = {}): SessionState {
  return {
    status: "paused", error: null, updated_at: "2026-09-27T10:00:00+00:00", seed: 42, speed: 1440, speeds: ALL_SPEEDS,
    step_seconds: 300 / 1440, tick_minutes: 5, start: { base_floor_pct: 30 }, homes: [], orders: {}, zones: {},
    charging_mw: 0, grid_down_zones: [], totals: null, log: [], honest_limits: [],
    scenario: { id: "beryl-landfall", name: "Beryl", alerts: [], first_ts: beryl.first_ts, last_ts: beryl.last_ts },
    tick_index: 22, tick_count: beryl.tick_count, tick: beryl.tick22, history: beryl.history,
    alerts: beryl.alerts, provenance: beryl.provenance22, counties: beryl.counties, ...over,
  } as unknown as SessionState
}

const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, target: null, ...extra })

describe("relative seek while playing (bug 1)", () => {
  const ctx = (over: Partial<ReplayKeyContext> = {}): ReplayKeyContext => ({
    status: "playing", speed: 1440, speeds: ALL_SPEEDS, canStep: false, stops: dayStops(ALL_SPEEDS),
    tickIndex: 22, tickCount: 193, tickMinutes: 5, canSeek: true, ...over,
  })

  it("sends a delta for , . and the Shift hour keys while playing, so the worker resolves it against its live tick", () => {
    expect(replayKeyRequest(key(","), ctx(), 0)).toEqual({ kind: "seek", body: { delta: -1 } })
    expect(replayKeyRequest(key("."), ctx(), 0)).toEqual({ kind: "seek", body: { delta: 1 } })
    expect(replayKeyRequest(key("<", { shiftKey: true }), ctx(), 0)).toEqual({ kind: "seek", body: { delta: -12 } })
    expect(replayKeyRequest(key(">", { shiftKey: true }), ctx(), 0)).toEqual({ kind: "seek", body: { delta: 12 } })
  })

  it("keeps an absolute tick while paused or finished, where the reported tick is where the worker is", () => {
    expect(replayKeyRequest(key(","), ctx({ status: "paused" }), 0)).toEqual({ kind: "seek", body: { tick: 21 } })
    expect(replayKeyRequest(key("<", { shiftKey: true }), ctx({ status: "paused" }), 0)).toEqual({ kind: "seek", body: { tick: 10 } })
    expect(replayKeyRequest(key(","), ctx({ status: "finished", tickIndex: 193 }), 0)).toEqual({ kind: "seek", body: { tick: 192 } })
  })

  it("still sends nothing at the ends while playing", () => {
    expect(replayKeyRequest(key(","), ctx({ tickIndex: 0 }), 0)).toBeNull()
    expect(replayKeyRequest(key("."), ctx({ tickIndex: 192 }), 0)).toBeNull()
  })

  it("sends the 1-hour buttons as deltas while playing and as ticks while paused", () => {
    expect(seekBy(berylSession({ status: "playing" }), -12)).toEqual({ kind: "seek", body: { delta: -12 } })
    expect(seekBy(berylSession({ status: "playing" }), 12)).toEqual({ kind: "seek", body: { delta: 12 } })
    expect(seekBy(berylSession({ status: "paused" }), 12)).toEqual({ kind: "seek", body: { tick: 34 } })
  })

  it("names the expected landing of a seek: the tick, or the reported tick plus the delta, clamped", () => {
    const state = berylSession({ status: "playing" })
    expect(seekLanding(state, { tick: 97 })).toBe(97)
    expect(seekLanding(state, { delta: -12 })).toBe(10)
    expect(seekLanding(state, { delta: 12 })).toBe(34)
    expect(seekLanding(berylSession({ tick_index: 5 }), { delta: -12 })).toBe(0)
    expect(seekLanding(berylSession({ tick_index: 190 }), { delta: 12 })).toBe(192)
  })

  it("posts the delta to /v1/scenario/seek", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ accepted: 4, kind: "seek" }), { status: 202 }))
    await expect(sendRequest(fetchFn as unknown as typeof fetch, "", { kind: "seek", body: { delta: -1 } })).resolves.toBe(4)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/v1/scenario/seek")
    expect(JSON.parse(String(init.body))).toEqual({ delta: -1 })
  })

  it("sends the Day bar's hour buttons as deltas while playing", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = createRoot(host)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const sent: FlowRequest[] = []
    act(() => { root.render(createElement(DayBar, { state: berylSession({ status: "playing" }), unavailable: null, onSend: (r: FlowRequest) => sent.push(r) } as never)) })
    act(() => { host.querySelector<HTMLButtonElement>('button[aria-label="Back 1 hour"]')!.click() })
    act(() => { host.querySelector<HTMLButtonElement>('button[aria-label="Forward 1 hour"]')!.click() })
    expect(sent).toEqual([{ kind: "seek", body: { delta: -12 } }, { kind: "seek", body: { delta: 12 } }])
    act(() => root.unmount())
    host.remove()
  })
})

describe("Seeking is held until the worker answers by seq (bug 2)", () => {
  const pending = { tick: 97, label: "06:00", atMs: 0, key: "beryl-landfall|42", sawSeeking: false, seq: 12, fromIndex: 22 }
  const obs = (over: Record<string, unknown>) => ({ seeking: false, tickIndex: 22, key: "beryl-landfall|42", ...over })

  it("does not let go on tick N alone when the worker reports last_seek", () => {
    expect(settleSeek(pending, obs({ tickIndex: 97, lastSeekSeq: 11 }), 500)).toEqual(pending)
    expect(settleSeek(pending, obs({ tickIndex: 97, lastSeekSeq: null }), 500)).toEqual(pending)
  })

  it("does not let go on seeking going true then false when the worker reports last_seek", () => {
    const seen = settleSeek(pending, obs({ seeking: true, lastSeekSeq: 11 }), 300)
    expect(seen).not.toBeNull()
    expect(settleSeek(seen, obs({ tickIndex: 98, lastSeekSeq: 11 }), 600)).not.toBeNull()
  })

  it("keeps waiting while the POST reply has not named the seq", () => {
    const noSeq = { ...pending, seq: null }
    expect(settleSeek(noSeq, obs({ tickIndex: 97, lastSeekSeq: 30 }), 500)).toMatchObject({ tick: 97 })
    expect(settleSeek(noSeq, obs({ tickIndex: 97, lastSeekSeq: null }), 500)).toMatchObject({ tick: 97 })
  })

  it("lets go on the seq, a run change, or the 10 s timeout", () => {
    expect(settleSeek(pending, obs({ lastSeekSeq: 12 }), 500)).toBeNull()
    expect(settleSeek(pending, obs({ lastSeekSeq: 11, key: "operator-hold|1" }), 500)).toBeNull()
    expect(settleSeek(pending, obs({ lastSeekSeq: 11 }), 10_001)).toBeNull()
  })

  it("keeps the old rules for a worker without last_seek", () => {
    expect(settleSeek(pending, obs({ tickIndex: 97 }), 500)).toBeNull()
  })
})

describe("the right end of the Day bar (bug 3)", () => {
  const state = berylSession()
  const win = dayWindow(state)!
  const lastSeekable = state.tick_count - 1

  it("maps a click at or after the last seekable tick's position to that tick", () => {
    const lastMs = seekMs(win, lastSeekable, 5)
    expect(seekIndexAt(win, lastMs, 5, state.tick_count)).toBe(lastSeekable)
    expect(seekIndexAt(win, (lastMs + win.endMs) / 2, 5, state.tick_count)).toBe(lastSeekable)
    expect(seekIndexAt(win, win.endMs, 5, state.tick_count)).toBe(lastSeekable)
  })

  it("previews the landing where the seek will land, with that tick's time, when dragged to the right end", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = createRoot(host)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const sent: FlowRequest[] = []
    act(() => { root.render(createElement(DayBar, { state, unavailable: null, onSend: (r: FlowRequest) => sent.push(r) } as never)) })
    const track = host.querySelector<HTMLDivElement>(".replay-day-track")!
    track.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 40, right: 1000, bottom: 40, x: 0, y: 0, toJSON: () => ({}) })
    act(() => { track.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 1000 })) })
    const preview = host.querySelector<HTMLDivElement>(".replay-day-preview")!
    expect(preview.textContent).toContain(`Seek to ${seekClock(win, lastSeekable, 5)}`)
    const posPct = ((seekMs(win, lastSeekable, 5) - win.startMs) / (win.endMs - win.startMs)) * 100
    expect(preview.style.transform).toBe(`translateX(${Math.round(posPct * 1000) / 1000}%)`)
    act(() => { track.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 1000 })) })
    expect(sent).toEqual([{ kind: "seek", body: { tick: lastSeekable } }])
    act(() => root.unmount())
    host.remove()
  })
})

describe("poll replies are applied in order (bug 4)", () => {
  it("drops a reply from an earlier poll once a later one is applied", () => {
    const newer = berylSession({ updated_at: "2026-09-27T10:00:05+00:00" })
    expect(freshReply(null, 1, newer)).toBe(true)
    expect(freshReply({ id: 2, updatedMs: Date.parse(newer.updated_at) }, 1, newer)).toBe(false)
    expect(freshReply({ id: 2, updatedMs: Date.parse(newer.updated_at) }, 3, newer)).toBe(true)
  })

  it("drops a reply whose state is older than the one on screen", () => {
    const shown = { id: 2, updatedMs: Date.parse("2026-09-27T10:00:05+00:00") }
    expect(freshReply(shown, 3, berylSession({ updated_at: "2026-09-27T10:00:04+00:00" }))).toBe(false)
    // Same second is not older (updated_at has whole seconds).
    expect(freshReply(shown, 3, berylSession({ updated_at: "2026-09-27T10:00:05+00:00" }))).toBe(true)
    // A worker-down reply has no updated_at; it is judged by poll order only.
    expect(freshReply(shown, 3, { status: "worker_not_running", brief: "x" } as never)).toBe(true)
  })

  describe("in the page", () => {
    let host: HTMLDivElement
    let root: Root
    beforeEach(() => {
      ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
      vi.useFakeTimers()
      host = document.createElement("div")
      document.body.appendChild(host)
      root = createRoot(host)
    })
    afterEach(() => {
      act(() => root.unmount())
      host.remove()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it("keeps the newer tick when an older poll reply lands after it", async () => {
      const replies: Array<(body: unknown) => void> = []
      vi.stubGlobal("fetch", vi.fn((url: string) => {
        if (String(url).endsWith("/v1/scenario/state")) {
          return new Promise((resolve) => replies.push((body) => resolve(new Response(JSON.stringify(body), { status: 200 }))))
        }
        if (String(url).endsWith("/v1/scenarios")) return Promise.resolve(new Response(JSON.stringify({ scenarios: [], speeds: ALL_SPEEDS, default_speed: 1440 }), { status: 200 }))
        return Promise.resolve(new Response("{}", { status: 404 }))
      }))
      act(() => { root.render(createElement(ReplayRoot)) })
      await act(async () => { vi.advanceTimersByTime(260) })
      expect(replies.length).toBeGreaterThanOrEqual(2)
      await act(async () => { replies[1](berylSession({ status: "playing", tick_index: 30, updated_at: "2026-09-27T10:00:06+00:00" })) })
      expect(host.textContent).toContain("Tick 30 of 193")
      await act(async () => { replies[0](berylSession({ status: "playing", tick_index: 28, updated_at: "2026-09-27T10:00:05+00:00" })) })
      expect(host.textContent).toContain("Tick 30 of 193")
      expect(host.textContent).not.toContain("Tick 28 of 193")
    })
  })
})
