import type { FlowRequest } from "../flow/api"
import type { ActiveAlert, HistoryPoint, SessionState } from "../flow/types"
import { isOperatorHold } from "./reasonCodes"
import type { SpeedStop } from "./tickClock"

/** The Replay Day view (Task 14): a bar spanning the scenario window by real `ts`, key-moment marks read from the
 * history the worker has played, and a playhead that glides between ticks. Pure.
 *
 * Honesty: every time and number here is a real tick's value. Only the playhead's position between two ticks is
 * interpolated (Task 14 ruling: the one exception to "every animation is one logged engine event"). A mark exists
 * only when a real field says so. */

// --- the shapes read here ---

/** A history point as the worker writes it (scenario.py `Session.step`), with only `tick` and `ts` required. The Task
 * 14 fields (`price_usd_mwh`, `price_label`, `mode`, `events`) are absent from older workers. */
export type DayHistoryPoint = Pick<HistoryPoint, "tick" | "ts"> & Partial<Omit<HistoryPoint, "tick" | "ts">>

/** The active-alert fields the alert mark reads (state `alerts[]`). */
export type DayAlert = Pick<ActiveAlert, "sent_at_tick"> & Partial<Pick<ActiveAlert, "event" | "expires">>

// --- the window ---

export type DayWindow = {
  startMs: number
  endMs: number
  startTs: string
  /** The last tick's ts, or the estimate when the worker did not report it. */
  endTs: string | null
  /** True when the end came from tick_count and tick_minutes, not from the worker's `last_ts`. */
  estimatedEnd: boolean
}

/** `state.scenario` with the tape's ends (Task 14 U4). */
export type ScenarioEnds = Partial<Pick<NonNullable<SessionState["scenario"]>, "first_ts" | "last_ts">>

type WindowInput = {
  history?: readonly Pick<DayHistoryPoint, "tick" | "ts">[]
  tick_count?: number
  tick_minutes?: number
  scenario?: ScenarioEnds | null
}

function parseMs(ts: string | null | undefined): number | null {
  if (!ts) return null
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? ms : null
}

/** The UTC offset a `ts` carries, in minutes (`-05:00` is -300), or null when it carries none. */
export function tsOffsetMin(ts: string | null | undefined): number | null {
  const match = /(?:([+-])(\d{2}):(\d{2})|Z)$/.exec(ts ?? "")
  if (!match) return null
  if (!match[1]) return 0
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
}

/** CST or CDT from the offset, as fmtScenarioTime reads it; empty for any other offset. */
export function zoneAbbr(ts: string | null | undefined): string {
  const offset = tsOffsetMin(ts)
  return offset === -360 ? "CST" : offset === -300 ? "CDT" : ""
}

/** The bar's ends: the worker's `first_ts` / `last_ts`, else the first history point plus the tick count (flagged
 * `estimatedEnd`), else null ("Scenario window not reported"). */
export function dayWindow(state: WindowInput | null | undefined): DayWindow | null {
  if (!state) return null
  const first = state.scenario?.first_ts ?? null
  const last = state.scenario?.last_ts ?? null
  const startMs = parseMs(first)
  const endMs = parseMs(last)
  if (first && startMs !== null && endMs !== null && endMs > startMs) {
    return { startMs, endMs, startTs: first, endTs: last, estimatedEnd: false }
  }
  const point = state.history?.[0]
  const pointMs = parseMs(point?.ts)
  const count = state.tick_count
  const minutes = state.tick_minutes
  if (!point || pointMs === null || typeof count !== "number" || !(count > 1) || typeof minutes !== "number" || !(minutes > 0)) {
    return null
  }
  return { startMs: pointMs, endMs: pointMs + (count - 1) * minutes * 60_000, startTs: point.ts, endTs: null, estimatedEnd: true }
}

/** Where `ms` sits on the bar, 0 to 1. */
export function posOf(window: Pick<DayWindow, "startMs" | "endMs">, ms: number): number {
  const span = window.endMs - window.startMs
  if (!(span > 0)) return 0
  return Math.min(1, Math.max(0, (ms - window.startMs) / span))
}

export type HourLabel = { ms: number; pos: number; text: string }

const HOUR_MS = 3_600_000

/** Whole local hours across the window (every 1, 2 or 3 h by its length), in the offset the first ts carries. The
 * first label names the zone (CST or CDT). No tape crosses a DST change, so one offset holds for the whole bar. */
export function hourLabels(window: DayWindow): HourLabel[] {
  const offsetMs = (tsOffsetMin(window.startTs) ?? 0) * 60_000
  const spanH = (window.endMs - window.startMs) / HOUR_MS
  const step = spanH <= 6 ? 1 : spanH <= 12 ? 2 : 3
  const firstLocal = Math.ceil((window.startMs + offsetMs) / HOUR_MS) * HOUR_MS
  const abbr = zoneAbbr(window.startTs)
  const out: HourLabel[] = []
  for (let local = firstLocal; local - offsetMs <= window.endMs; local += step * HOUR_MS) {
    const ms = local - offsetMs
    const hour = new Date(local).getUTCHours()
    const text = `${String(hour).padStart(2, "0")}:00`
    out.push({ ms, pos: posOf(window, ms), text: out.length === 0 && abbr ? `${text} ${abbr}` : text })
  }
  return out
}

/** Local "HH:MM" of a ts, from its own digits. */
export function clockOf(ts: string | null | undefined): string {
  const match = /T(\d{2}):(\d{2})/.exec(ts ?? "")
  return match ? `${match[1]}:${match[2]}` : ""
}

// --- key-moment marks ---

/** A price at or above this is marked as a spike. The engine's sell band is not in the state file, so the bar uses
 * this fixed display threshold and says so in every price mark and in the legend. */
export const PRICE_SPIKE_USD = 100

export type DayMarkKind = "hold" | "alert" | "price" | "call" | "missed" | "fault"

export type DayMark = {
  kind: DayMarkKind
  /** What the mark says, from the data (event names, labels, prices). */
  label: string
  startTs: string
  endTs: string
  startMs: number
  endMs: number
  firstTick: number
  lastTick: number
  /** One tick only. */
  point: boolean
}

type Run = { first: DayHistoryPoint; last: DayHistoryPoint; points: DayHistoryPoint[] }

/** Contiguous runs (consecutive tick numbers) of history points where `test` holds. */
function runs(history: readonly DayHistoryPoint[], test: (point: DayHistoryPoint) => boolean): Run[] {
  const out: Run[] = []
  let current: Run | null = null
  for (const point of history) {
    if (!test(point)) {
      current = null
      continue
    }
    if (current && point.tick === current.last.tick + 1) {
      current.last = point
      current.points.push(point)
    } else {
      current = { first: point, last: point, points: [point] }
      out.push(current)
    }
  }
  return out
}

function markOf(kind: DayMarkKind, label: string, run: Run): DayMark | null {
  const startMs = parseMs(run.first.ts)
  const endMs = parseMs(run.last.ts)
  if (startMs === null || endMs === null) return null
  return {
    kind, label, startTs: run.first.ts, endTs: run.last.ts, startMs, endMs, firstTick: run.first.tick, lastTick: run.last.tick,
    point: run.first.tick === run.last.tick,
  }
}

function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function money(value: number): string {
  return `$${Math.round(value * 100) / 100}/MWh`
}

/** Hand-placed tape events (contracts.py TapeFrame.events), named as overlays. `operator` is the HOLD mark and
 * `weather` / `weather_counties` are the alert mark, so they are not repeated here. */
const FAULT_EVENTS: Array<[string, string]> = [
  ["network", "Overlay: lossy network"],
  ["crash", "Overlay: homes crash"],
  ["misreport", "Overlay: misreported charge"],
  ["short_delivery", "Overlay: short delivery"],
  ["dead", "Overlay: homes dead"],
  ["stale", "Overlay: homes stale"],
  ["live", "Overlay: homes back live"],
  ["grid_down", "Overlay: grid down"],
]

/** The engine's own dead-home count, for a worker that sends no `events`. Never `timed_out`: a command that timed
 * out is not a fault the tape placed. */
function homesDead(point: DayHistoryPoint): number | null {
  for (const reason of point.reasons ?? []) {
    const match = /^homes_dead:(\d+)$/.exec(reason)
    if (match) return Number(match[1])
  }
  return null
}

const MISSED_EPS_MW = 1e-6

/** Marks from what has played: the history points (and, for alerts, the active alerts' `sent_at_tick` and archived
 * `expires`). Marks appear only as ticks play; a missing field gives no mark. */
export function dayMarks(history: readonly DayHistoryPoint[], alerts: readonly DayAlert[] | null | undefined,
  opts: { priceSpikeUsd?: number } = {}): DayMark[] {
  const spike = opts.priceSpikeUsd ?? PRICE_SPIKE_USD
  const out: Array<DayMark | null> = []

  for (const run of runs(history, (point) => isOperatorHold(point))) out.push(markOf("hold", "Operator HOLD: no orders", run))

  for (const alert of alerts ?? []) {
    if (typeof alert.sent_at_tick !== "number") continue
    const expiresMs = parseMs(alert.expires)
    const applied = runs(history, (point) => {
      const ms = parseMs(point.ts)
      return point.tick >= (alert.sent_at_tick as number) && ms !== null && (expiresMs === null || ms <= expiresMs)
    })[0]
    // The alert applies from sent_at_tick; nothing is marked until that tick has played.
    if (applied && applied.first.tick === alert.sent_at_tick) out.push(markOf("alert", `NWS ${alert.event ?? "alert"}`, applied))
  }

  for (const run of runs(history, (point) => isNum(point.price_usd_mwh) && point.price_usd_mwh >= spike)) {
    const peak = Math.max(...run.points.map((point) => point.price_usd_mwh as number))
    const label = run.first.price_label ? ` (${run.first.price_label})` : ""
    out.push(markOf("price", `Price at or above ${money(spike)}, peak ${money(peak)}${label}`, run))
  }

  for (const run of runs(history, (point) => point.intent === "discharge")) out.push(markOf("call", "Fleet sold on the call", run))
  for (const run of runs(history, (point) => isNum(point.missed_mw) && point.missed_mw > MISSED_EPS_MW)) {
    out.push(markOf("missed", "Call missed (part or all of the ask)", run))
  }

  const withEvents = history.some((point) => Array.isArray(point.events))
  if (withEvents) {
    for (const [key, label] of FAULT_EVENTS) {
      for (const run of runs(history, (point) => Array.isArray(point.events) && point.events.includes(key))) {
        out.push(markOf("fault", label, run))
      }
    }
  } else {
    for (const point of history) {
      const dead = homesDead(point)
      if (dead !== null && dead > 0) {
        out.push(markOf("fault", `Homes dead: ${dead} (engine reason)`, { first: point, last: point, points: [point] }))
      }
    }
  }
  return out.filter((mark): mark is DayMark => mark !== null)
}

// --- the playhead ---

/** Anchored like tickClock's Playhead: re-anchored on each poll at the current position, so it never goes
 * backwards while playing. `fromFrac` is the share of the tick (0 to 1) already played at `atMs`. */
export type DayHead = {
  tickIndex: number | null
  tsMs: number | null
  atMs: number
  fromFrac: number
  stepSeconds: number
  tickMs: number
  moving: boolean
}

export type DayObservation = {
  tickIndex: number
  /** The current tick's ts in ms, or null when no tick has played. */
  tsMs: number | null
  playing: boolean
  stepSeconds: number
  tickMinutes: number
  /** The worker's `tick_left_s`: real seconds left in this tick. Null or undefined when it does not say. */
  tickLeft?: number | null
  nowMs: number
}

export function initialDayHead(): DayHead {
  return { tickIndex: null, tsMs: null, atMs: 0, fromFrac: 0, stepSeconds: 0, tickMs: 0, moving: false }
}

function fracAt(head: DayHead, nowMs: number): number {
  if (!head.moving || !(head.stepSeconds > 0)) return head.fromFrac
  return Math.min(1, Math.max(0, head.fromFrac + (nowMs - head.atMs) / 1000 / head.stepSeconds))
}

function knownFrac(obs: DayObservation): number | null {
  if (typeof obs.tickLeft !== "number" || !(obs.stepSeconds > 0)) return null
  return Math.min(1, Math.max(0, (obs.stepSeconds - obs.tickLeft) / obs.stepSeconds))
}

export function advanceDayHead(prev: DayHead, obs: DayObservation): DayHead {
  const tickMs = Math.max(0, obs.tickMinutes) * 60_000
  const base = { tickIndex: obs.tickIndex, tsMs: obs.tsMs, atMs: obs.nowMs, stepSeconds: obs.stepSeconds, tickMs }
  // Paused, finished or no tick: rest exactly at the tick's ts.
  if (obs.tsMs === null || !obs.playing) return { ...base, fromFrac: 0, moving: false }
  const known = knownFrac(obs)
  if (obs.tickIndex !== prev.tickIndex || obs.tsMs !== prev.tsMs || !prev.moving) {
    // A new tick, or Play: start where the worker says this tick is.
    return { ...base, fromFrac: known ?? 0, moving: true }
  }
  // Same tick, still playing: re-anchor here. A late time-left never pulls the playhead back.
  const current = fracAt(prev, obs.nowMs)
  return { ...base, fromFrac: Math.max(current, known ?? current), moving: true }
}

/** The playhead in ms: the tick's ts plus the share of the tick played, never past the next tick. */
export function dayPlayheadMs(head: DayHead, nowMs: number): number | null {
  if (head.tsMs === null) return null
  return head.tsMs + fracAt(head, nowMs) * head.tickMs
}

// --- pace ---

/** Day view presets, slowest first: 5, 2 and 1 min per 24-hour scenario day (86400 / x seconds). Rajat's ruling:
 * round numbers only. Watch orders keeps tickClock's SPEED_STOPS. */
export const DAY_STOPS: SpeedStop[] = [
  { x: 288, name: null, about: false },
  { x: 720, name: null, about: false },
  { x: 1440, name: null, about: false },
]

/** The preset Day view asks for on Play or Start when the speed is not a day stop: about 1 min per day (ruling). */
export const DEFAULT_DAY_SPEED = 1440

function trimNumber(value: number): string {
  return String(Math.round(value * 10) / 10)
}

/** Real minutes one 24-hour scenario day takes at time-lapse `x` (scenario seconds per real second). */
export function dayPaceLabel(x: number): string {
  const minutes = 1440 / x
  if (minutes >= 60) return `${trimNumber(minutes / 60)} h per day`
  return `${trimNumber(minutes)} min per day`
}

/** The day stops this session offers. A worker without them gets its fastest real speed, labeled by its real pace. */
export function dayStops(speeds: readonly number[] | undefined | null): SpeedStop[] {
  if (!speeds?.length) return []
  const offered = DAY_STOPS.filter((stop) => speeds.includes(stop.x))
  if (offered.length) return offered
  return [{ x: Math.max(...speeds), name: null, about: false }]
}

export type TickArrival = { tickIndex: number; atMs: number }

/** Real seconds per tick from recent arrivals (first seen by a poll), or null with fewer than three arrivals or two
 * ticks. Both ends are poll-quantized alike, so the rate over the span is fair. */
export function observedSecondsPerTick(arrivals: readonly TickArrival[]): number | null {
  if (arrivals.length < 3) return null
  const first = arrivals[0]
  const last = arrivals[arrivals.length - 1]
  const ticks = last.tickIndex - first.tickIndex
  if (!(ticks >= 2) || !(last.atMs > first.atMs)) return null
  return (last.atMs - first.atMs) / 1000 / ticks
}

/** The worker is this much slower than asked before the page says so. */
export const PACE_BEHIND = 0.15

/** "Asked 1 min per day; the worker is playing about 1.2 min per day", only when more than 15% behind. */
export function paceReadout(speed: number | null | undefined, observedSeconds: number | null | undefined, tickMinutes: number | null | undefined): string | null {
  if (!isNum(speed) || !(speed > 0) || !isNum(observedSeconds) || !isNum(tickMinutes) || !(tickMinutes > 0)) return null
  const askedSeconds = (tickMinutes * 60) / speed
  if (!(observedSeconds > askedSeconds * (1 + PACE_BEHIND) + 1e-9)) return null
  const playedX = (tickMinutes * 60) / observedSeconds
  return `Asked ${dayPaceLabel(speed)}; the worker is playing about ${dayPaceLabel(playedX)}`
}

/** Tick arrivals kept for the pace, with the run and speed they were measured in. */
export type ArrivalTrack = { key: string | null; speed: number | null; list: TickArrival[] }

export type ArrivalObservation = { key: string | null; tickIndex: number; playing: boolean; speed: number; atMs: number }

/** Arrivals kept for the pace readout: enough for a fair rate, few enough to follow a change. */
const ARRIVALS_KEPT = 8

export function emptyArrivals(): ArrivalTrack {
  return { key: null, speed: null, list: [] }
}

/** Adds a poll's tick to the pace ring buffer. A new run, a rewind, a pause or a speed change starts it again, so the
 * readout only ever measures uninterrupted play at one speed. */
export function trackArrivals(prev: ArrivalTrack, obs: ArrivalObservation): ArrivalTrack {
  if (!obs.playing) return { key: obs.key, speed: obs.speed, list: [] }
  const last = prev.list.at(-1)
  const fresh = obs.key !== prev.key || obs.speed !== prev.speed || (last !== undefined && obs.tickIndex < last.tickIndex)
  if (fresh) return { key: obs.key, speed: obs.speed, list: [{ tickIndex: obs.tickIndex, atMs: obs.atMs }] }
  if (last && last.tickIndex === obs.tickIndex) return prev
  return { ...prev, list: [...prev.list, { tickIndex: obs.tickIndex, atMs: obs.atMs }].slice(-ARRIVALS_KEPT) }
}

// --- the run, and the view's speed ---

/** One run of one scenario: its id and seed. A new start or reset gives a new key, and the Day bar starts over. */
export function runKey(state: Pick<SessionState, "scenario" | "seed"> | null | undefined): string | null {
  const id = state?.scenario?.id
  return id ? `${id}|${state?.seed ?? ""}` : null
}

/** Rajat's coupling: Play or Start in Day view first asks for the default day stop when the session's speed is not
 * one (the fastest offered when this worker has none). Null when no speed request is needed. */
export function viewPlaySpeed(view: "day" | "orders", request: FlowRequest,
  state: Pick<SessionState, "speed" | "speeds"> | null | undefined): number | null {
  if (view !== "day" || !state) return null
  const starts = request.kind === "start" || (request.kind === "play" && request.body.playing)
  if (!starts) return null
  const stops = dayStops(state.speeds)
  if (!stops.length || stops.some((stop) => stop.x === state.speed)) return null
  return (stops.find((stop) => stop.x === DEFAULT_DAY_SPEED) ?? stops[stops.length - 1]).x
}

/** Watch orders plays one tick's order window, so switching to it slows a day-pace session to 12 (25 s per tick). */
export const ORDERS_VIEW_SPEED = 12
const ORDERS_VIEW_MAX = 60

export function ordersViewSpeed(state: Pick<SessionState, "speed" | "speeds"> | null | undefined): number | null {
  if (!state || !(state.speed > ORDERS_VIEW_MAX) || !state.speeds?.includes(ORDERS_VIEW_SPEED)) return null
  return ORDERS_VIEW_SPEED
}

// --- seeking (Task 16B) ---
// The worker's seek re-runs the engine (same seed, same logged operator actions), so every tick shown after a seek is
// a real engine tick. N is a tick index: the number of ticks played, so tick index N shows frame N - 1. The worker
// clamps N to [0, tick_count - 1] and, after a seek to N, reports tick N first.

type SeekState = Pick<SessionState, "status" | "tick_index" | "tick_count" | "tick_minutes"> & { seeking?: boolean }

export function ticksPerHour(tickMinutes: number): number {
  return tickMinutes > 0 ? Math.max(1, Math.round(60 / tickMinutes)) : 1
}

/** N inside the worker's seek range. */
export function clampSeek(index: number, tickCount: number): number {
  return Math.max(0, Math.min(Math.round(index), tickCount - 1))
}

/** The tick index whose tick sits nearest `ms` on the bar (frame p at start + p ticks is index p + 1). Tapes are evenly
 * spaced at tick_minutes (checked in tests/test_scenario_playback.py). */
export function seekIndexAt(win: Pick<DayWindow, "startMs" | "endMs">, ms: number, tickMinutes: number, tickCount: number): number {
  const tickMs = tickMinutes * 60_000
  if (!(tickMs > 0)) return 0
  const clamped = Math.min(win.endMs, Math.max(win.startMs, ms))
  return clampSeek(Math.round((clamped - win.startMs) / tickMs) + 1, tickCount)
}

/** Where tick index N's tick sits, in ms (index 0, before the first tick, sits at the start). */
export function seekMs(win: Pick<DayWindow, "startMs">, index: number, tickMinutes: number): number {
  return win.startMs + Math.max(0, index - 1) * tickMinutes * 60_000
}

/** Local "HH:MM" of tick index N's tick, in the offset the window's first ts carries. */
export function seekClock(win: Pick<DayWindow, "startMs" | "startTs">, index: number, tickMinutes: number): string {
  const local = new Date(seekMs(win, index, tickMinutes) + (tsOffsetMin(win.startTs) ?? 0) * 60_000)
  return `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`
}

/** A seek can be sent: a scenario is loaded and no seek is running. */
export function canSeek(state: SeekState | null | undefined): boolean {
  return !!state && ["playing", "paused", "finished"].includes(state.status) && state.seeking !== true
    && typeof state.tick_index === "number" && typeof state.tick_count === "number" && state.tick_count > 1
}

/** A seek `delta` ticks from here, or null when none can be sent or it would not move. */
export function seekBy(state: SeekState | null | undefined, delta: number): FlowRequest | null {
  if (!state || !canSeek(state)) return null
  return seekTo(state, state.tick_index + delta)
}

/** A seek to tick index N (clamped), or null when it would not move. */
export function seekTo(state: Pick<SessionState, "tick_index" | "tick_count">, index: number): FlowRequest | null {
  const tick = clampSeek(index, state.tick_count)
  return tick === state.tick_index ? null : { kind: "seek", body: { tick } }
}

/** A seek the page sent and has not seen land. */
export type SeekPending = { tick: number; label: string | null; atMs: number; key: string | null; sawSeeking: boolean }

/** A seek that never lands stops showing "Seeking" after this long (the worst seek is about 3.3 s; Task 16A). */
export const SEEK_WAIT_MS = 10_000

/** Keeps a sent seek until the worker lands on it (tick N first) or finishes seeking, the run changes, or it waits too
 * long. */
export function settleSeek(pending: SeekPending | null, obs: { seeking?: boolean; tickIndex: number; key: string | null },
  nowMs: number): SeekPending | null {
  if (!pending) return null
  if (obs.key !== pending.key || nowMs - pending.atMs > SEEK_WAIT_MS) return null
  if (obs.seeking === true) return pending.sawSeeking ? pending : { ...pending, sawSeeking: true }
  if (obs.tickIndex === pending.tick || pending.sawSeeking) return null
  return pending
}
