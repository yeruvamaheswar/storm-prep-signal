import { useEffect, useMemo, useState } from "react"
import type { FlowRequest } from "../flow/api"
import { fmtScenarioTime } from "../flow/flowMath"
import {
  PRICE_SPIKE_USD, clockOf, dayMarks, dayPaceLabel, dayStops, dayWindow, hourLabels, paceReadout, posOf, zoneAbbr,
  type DayAlert, type DayHistoryPoint, type DayMarkKind, type ScenarioEnds,
} from "./dayModel"

/** The session fields the day bar reads. A `SessionState` fits; kept local while Task 15 edits flow/types. */
export type DayBarState = {
  status: string
  speed: number
  speeds?: readonly number[] | null
  tick_minutes: number
  tick_index: number
  tick_count: number
  tick: { ts: string } | null
  history?: readonly DayHistoryPoint[]
  alerts?: readonly DayAlert[]
  scenario?: ScenarioEnds | null
}

type Props = {
  state: DayBarState
  /** The glided playhead in ms (dayModel.dayPlayheadMs); null or missing rests at the tick's ts. */
  playheadMs?: number | null
  /** Real seconds per tick measured from arrivals while playing; null when not measured. */
  observedStepSeconds?: number | null
  /** Why the pace presets are off (no scenario list, no session speeds), or null. */
  unavailable: string | null
  onSend: (request: FlowRequest) => void
}

/** A sent pace shows as pressed until the session reports it, or this long if it never does (same as the slider). */
const PENDING_SPEED_MS = 3000

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

function pct(value: number): string {
  return `${Math.round(value * 100000) / 1000}%`
}

/** The Replay Day view (Task 14): the scenario window by real ts, the marks that have played, and the pace presets. */
export function DayBar({ state, playheadMs, observedStepSeconds, unavailable, onSend }: Props) {
  const window = useMemo(() => dayWindow(state), [state])
  const hours = useMemo(() => (window ? hourLabels(window) : []), [window])
  const marks = useMemo(() => dayMarks(state.history ?? [], state.alerts ?? []), [state.history, state.alerts])
  const stops = dayStops(unavailable ? null : state.speeds)
  const [pending, setPending] = useState<{ x: number; from: number } | null>(null)

  useEffect(() => {
    if (pending === null) return
    const timer = setTimeout(() => setPending(null), PENDING_SPEED_MS)
    return () => clearTimeout(timer)
  }, [pending])

  const shown = pending && pending.from === state.speed ? pending.x : state.speed
  const tickTs = state.tick?.ts ?? null
  const tickMs = tickTs ? Date.parse(tickTs) : NaN
  const headMs = typeof playheadMs === "number" && Number.isFinite(playheadMs) ? playheadMs : Number.isFinite(tickMs) ? tickMs : null
  const played = window && headMs !== null ? posOf(window, headMs) : 0
  const tickText = typeof state.tick_index === "number" && typeof state.tick_count === "number"
    ? `Tick ${state.tick_index} of ${state.tick_count} · ${tickTs ? fmtScenarioTime(tickTs) : "no tick played yet"}`
    : "Tick not reported"
  const readout = state.status === "playing" ? paceReadout(state.speed, observedStepSeconds, state.tick_minutes) : null
  const abbr = zoneAbbr(tickTs ?? window?.startTs)

  return (
    <div className="replay-day">
      <div className="replay-day-main">
        <div className="replay-day-top">
          <b className="replay-day-now">{tickText}</b>
          {window?.estimatedEnd ? <span className="replay-day-note">End estimated from the tick count</span> : null}
          {readout ? <span className="replay-day-readout" role="status">{readout}</span> : null}
        </div>
        {window ? (
          <div className="replay-day-track" aria-label={`Scenario day, ${clockOf(window.startTs)} to ${window.endTs ? clockOf(window.endTs) : "an estimated end"} ${abbr}`.trim()}>
            <div className="replay-day-marks" role="group" aria-label="Key moments so far">
              {marks.map((mark, k) => {
                const start = posOf(window, mark.startMs)
                const end = posOf(window, mark.endMs)
                const when = mark.point ? `at ${clockOf(mark.startTs)}` : `${clockOf(mark.startTs)} to ${clockOf(mark.endTs)}`
                const text = `${mark.label}, ${when}${abbr ? ` ${abbr}` : ""}`
                return (
                  <span key={`${mark.kind}-${mark.firstTick}-${k}`} role="img" aria-label={text} title={text}
                    className={`replay-day-mark is-${mark.kind}${mark.point ? " is-point" : ""}`}
                    style={{ left: pct(start), width: pct(Math.max(0, end - start)), top: LANES.indexOf(mark.kind) * 4 }} />
                )
              })}
            </div>
            <div className="replay-day-rail" />
            <div className="replay-day-fill" style={{ transform: `scaleX(${played})` }} />
            <div className="replay-day-head" style={{ transform: `translateX(${pct(played)})` }}><span /></div>
            <div className="replay-day-hours" aria-hidden="true">
              {hours.map((hour) => (
                <span key={hour.ms} className={hour.pos >= 0.97 ? "is-end" : hour.pos <= 0.03 ? "is-start" : ""} style={{ left: pct(hour.pos) }}>{hour.text}</span>
              ))}
            </div>
          </div>
        ) : (
          <p className="replay-day-missing">Scenario window not reported</p>
        )}
      </div>
      <div className="replay-day-side">
        {unavailable ? <span className="replay-day-note">{unavailable}</span> : (
          <div className="replay-day-presets" role="group" aria-label="Pace">
            {stops.map((stop) => (
              <button key={stop.x} type="button" aria-pressed={shown === stop.x} title="Pace ([ slower, ] faster)"
                onClick={() => {
                  if (stop.x === shown) return
                  setPending({ x: stop.x, from: state.speed })
                  onSend({ kind: "speed", body: { x: stop.x } })
                }}>{dayPaceLabel(stop.x)}</button>
            ))}
          </div>
        )}
        <ul className="replay-day-legend" aria-label="Marks">
          {LEGEND.map((item) => <li key={item.kind}><i className={`is-${item.kind}`} aria-hidden="true" />{item.text}</li>)}
        </ul>
      </div>
    </div>
  )
}
