import { useMemo, useRef, useState, type PointerEvent } from "react"
import type { FlowRequest } from "../flow/api"
import { fmtScenarioTime } from "../flow/flowMath"
import type { SessionState } from "../flow/types"
import {
  PRICE_SPIKE_USD, canSeek, clockOf, dayMarks, dayPaceLabel, dayStops, dayWindow, hourLabels, paceReadout, posOf, seekBy,
  seekClock, seekIndexAt, seekMs, seekTo, ticksPerHour, zoneAbbr, type DayMarkKind,
} from "./dayModel"
import { usePendingSpeed } from "./usePendingSpeed"

/** The session fields the day bar reads. */
export type DayBarState = Pick<SessionState, "status" | "speed" | "tick_minutes" | "tick_index" | "tick_count"> &
  Partial<Pick<SessionState, "speeds" | "history" | "alerts" | "scenario" | "seeking">> & { tick: { ts: string } | null }

/** A seek the page sent (ReplayRoot) or the worker reports: `busy` disables the seek controls; `label` is the landing
 * tick's time and `tick` its index, when this page sent it. */
export type DaySeek = { busy: boolean; label?: string | null; tick?: number | null }

type Props = {
  state: DayBarState
  /** The glided playhead in ms (dayModel.dayPlayheadMs); null or missing rests at the tick's ts. */
  playheadMs?: number | null
  /** Real seconds per tick measured from arrivals while playing; null when not measured. */
  observedStepSeconds?: number | null
  /** Why the pace presets are off (no scenario list, no session speeds), or null. */
  unavailable: string | null
  seek?: DaySeek | null
  onSend: (request: FlowRequest) => void
}

/** One lane per kind, so marks never cover each other. Colors are existing tokens (replay.css). */
const LANES: DayMarkKind[] = ["hold", "alert", "price", "call", "missed", "fault"]

const LEGEND: Array<{ kind: DayMarkKind; text: string }> = [
  { kind: "hold", text: "Operator HOLD" },
  { kind: "alert", text: "NWS alert applied" },
  { kind: "price", text: `Price at or above $${PRICE_SPIKE_USD}/MWh (display threshold)` },
  { kind: "call", text: "Fleet sold on the call" },
  { kind: "missed", text: "Call missed" },
  { kind: "fault", text: "Overlay (hand-placed fault)" },
]

/** Hour labels far enough apart not to overlap on a narrow bar (the first one also names CST or CDT). */
function spaced<T extends { pos: number }>(labels: T[]): T[] {
  const out: T[] = []
  for (const label of labels) {
    const last = out[out.length - 1]
    if (!last || label.pos - last.pos >= (out.length === 1 ? 0.2 : 0.12)) out.push(label)
  }
  return out
}

function pct(value: number): string {
  return `${Math.round(value * 100000) / 1000}%`
}

/** The Replay Day view (Task 14): the scenario window by real ts, the marks that have played, the pace presets, and
 * seeking (Task 16B: click or drag the track, or Back / Forward 1 hour). A seek re-runs the engine, so the tick shown
 * after it is a real tick; while it runs the bar says so and the seek controls are off. */
export function DayBar({ state, playheadMs, observedStepSeconds, unavailable, seek, onSend }: Props) {
  const dayWin = useMemo(() => dayWindow(state), [state])
  const hours = useMemo(() => (dayWin ? spaced(hourLabels(dayWin)) : []), [dayWin])
  const marks = useMemo(() => dayMarks(state.history ?? [], state.alerts ?? []), [state.history, state.alerts])
  const stops = dayStops(unavailable ? null : state.speeds)
  const { shown, mark } = usePendingSpeed(state.speed)
  const trackRef = useRef<HTMLDivElement | null>(null)
  // The tick index under the pointer while dragging; one seek goes on release.
  const [drag, setDrag] = useState<number | null>(null)

  const tickTs = state.tick?.ts ?? null
  const tickMs = tickTs ? Date.parse(tickTs) : NaN
  const headMs = typeof playheadMs === "number" && Number.isFinite(playheadMs) ? playheadMs : Number.isFinite(tickMs) ? tickMs : null
  const played = dayWin && headMs !== null ? posOf(dayWin, headMs) : 0
  const tickText = typeof state.tick_index === "number" && typeof state.tick_count === "number"
    ? `Tick ${state.tick_index} of ${state.tick_count} · ${tickTs ? fmtScenarioTime(tickTs) : "no tick played yet"}`
    : "Tick not reported"
  const readout = state.status === "playing" ? paceReadout(state.speed, observedStepSeconds, state.tick_minutes) : null
  const abbr = zoneAbbr(tickTs ?? dayWin?.startTs)

  const busy = seek?.busy === true || state.seeking === true
  const seekable = !busy && canSeek(state)
  const hour = ticksPerHour(state.tick_minutes)
  const back = seekable ? seekBy(state, -hour) : null
  const forward = seekable ? seekBy(state, hour) : null
  const seekingText = busy ? (seek?.label ? `Seeking to ${seek.label}…` : "Seeking…") : null
  // Where the seek will land: the drag preview, or the target of a seek this page sent.
  const ghost = drag ?? (busy && typeof seek?.tick === "number" ? seek.tick : null)

  function indexAt(clientX: number): number | null {
    const el = trackRef.current
    if (!el || !dayWin) return null
    const rect = el.getBoundingClientRect()
    if (!(rect.width > 0)) return null
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return seekIndexAt(dayWin, dayWin.startMs + frac * (dayWin.endMs - dayWin.startMs), state.tick_minutes, state.tick_count)
  }

  function onDown(event: PointerEvent<HTMLDivElement>) {
    if (!seekable || event.button > 0) return
    const index = indexAt(event.clientX)
    if (index === null) return
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // No capture (a synthetic event): the drag still ends on this element's pointerup.
    }
    setDrag(index)
  }

  function onMove(event: PointerEvent<HTMLDivElement>) {
    if (drag === null) return
    const index = indexAt(event.clientX)
    if (index !== null && index !== drag) setDrag(index)
  }

  function onUp(event: PointerEvent<HTMLDivElement>) {
    if (drag === null) return
    const index = indexAt(event.clientX) ?? drag
    setDrag(null)
    const request = seekable ? seekTo(state, index) : null
    if (request) onSend(request)
  }

  function send(request: FlowRequest | null) {
    if (request) onSend(request)
  }

  return (
    <div className="replay-day">
      <div className="replay-day-main">
        <div className="replay-day-top">
          <b className="replay-day-now">{tickText}</b>
          <span className="replay-day-seek">
            <button type="button" className="replay-day-jump" aria-label="Back 1 hour" title="Back 1 hour (Shift+,)" disabled={!back}
              onClick={() => send(back)}>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2 L3.5 6 L7.5 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              1 h
            </button>
            <button type="button" className="replay-day-jump" aria-label="Forward 1 hour" title="Forward 1 hour (Shift+.)" disabled={!forward}
              onClick={() => send(forward)}>
              1 h
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2 L8.5 6 L4.5 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </span>
          {seekingText ? <span className="replay-day-seeking" role="status">{seekingText}</span> : null}
          {dayWin?.estimatedEnd ? <span className="replay-day-note">End estimated from the tick count</span> : null}
          {readout ? <span className="replay-day-readout" role="status">{readout}</span> : null}
        </div>
        {dayWin ? (
          <div className={`replay-day-track${busy ? " is-seeking" : ""}`} role="group"
            aria-label={`Scenario day, ${clockOf(dayWin.startTs)} to ${dayWin.endTs ? clockOf(dayWin.endTs) : "an estimated end"} ${abbr}`.trim()}
            ref={trackRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
            onPointerCancel={() => setDrag(null)}>
            <div className="replay-day-marks" role="group" aria-label="Key moments so far">
              {marks.map((m, k) => {
                const start = posOf(dayWin, m.startMs)
                const end = posOf(dayWin, m.endMs)
                const when = m.point ? `at ${clockOf(m.startTs)}` : `${clockOf(m.startTs)} to ${clockOf(m.endTs)}`
                const text = `${m.label}, ${when}${abbr ? ` ${abbr}` : ""}`
                return (
                  <span key={`${m.kind}-${m.firstTick}-${k}`} role="img" aria-label={text} title={text}
                    className={`replay-day-mark is-${m.kind}${m.point ? " is-point" : ""}`}
                    style={{ left: pct(start), width: pct(Math.max(0, end - start)), top: LANES.indexOf(m.kind) * 4 }} />
                )
              })}
            </div>
            <div className="replay-day-rail" />
            <div className="replay-day-fill" style={{ transform: `scaleX(${played})` }} />
            <div className="replay-day-head" style={{ transform: `translateX(${pct(played)})` }}><span /></div>
            {ghost !== null ? (
              <div className="replay-day-preview" style={{ transform: `translateX(${pct(posOf(dayWin, seekMs(dayWin, ghost, state.tick_minutes)))})` }}>
                <span />
                {drag !== null ? <b>Seek to {seekClock(dayWin, ghost, state.tick_minutes)}</b> : null}
              </div>
            ) : null}
            <div className="replay-day-hours" aria-hidden="true">
              {hours.map((h) => (
                <span key={h.ms} className={h.pos >= 0.97 ? "is-end" : h.pos <= 0.03 ? "is-start" : ""} style={{ left: pct(h.pos) }}>{h.text}</span>
              ))}
            </div>
          </div>
        ) : (
          <p className="replay-day-missing">Scenario window not reported</p>
        )}
        <ul className="replay-day-legend" aria-label="Marks">
          {LEGEND.map((item) => <li key={item.kind}><i className={`is-${item.kind}`} aria-hidden="true" />{item.text}</li>)}
        </ul>
      </div>
      <div className="replay-day-side">
        {unavailable ? <span className="replay-day-note">{unavailable}</span> : (
          <div className="replay-day-presets" role="group" aria-label="Pace">
            {stops.map((stop) => (
              <button key={stop.x} type="button" aria-pressed={shown === stop.x} title="Pace ([ slower, ] faster)"
                onClick={() => {
                  if (stop.x === shown) return
                  mark(stop.x)
                  onSend({ kind: "speed", body: { x: stop.x } })
                }}>{dayPaceLabel(stop.x)}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
