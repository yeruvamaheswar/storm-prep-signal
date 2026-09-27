import { useEffect, useState } from "react"
import type { FlowRequest } from "../flow/api"
import { fmtScenarioTime } from "../flow/flowMath"
import type { SessionState } from "../flow/types"
import { availableStops, fmtClock, speedLabel } from "./tickClock"

type Props = {
  state: SessionState | null
  tSeconds: number
  /** False when the scenario catalog (and so the session speeds) could not be fetched. */
  speedsAvailable?: boolean
  onSend: (request: FlowRequest) => void
}

/** A sent speed shows on the slider until the session reports it, or this long if it never does. */
const PENDING_SPEED_MS = 3000

/** "Tick N of M" and the share of the run played, from the session's own counters. Null when not reported. */
export function tickProgress(state: Pick<SessionState, "tick_index" | "tick_count"> | null): { label: string; pct: number | null } {
  const index = state?.tick_index
  const total = state?.tick_count
  if (typeof index !== "number" || typeof total !== "number" || !(total > 0)) return { label: "Tick not reported", pct: null }
  return { label: `Tick ${index} of ${total}`, pct: Math.min(100, Math.max(0, (index / total) * 100)) }
}

/** Next tick works while paused with ticks left to play. */
export function canStep(state: Pick<SessionState, "status" | "tick_index" | "tick_count"> | null): boolean {
  return state?.status === "paused" && typeof state.tick_index === "number" && typeof state.tick_count === "number"
    && state.tick_index < state.tick_count
}

function speedUnavailable(state: SessionState | null, speedsAvailable: boolean, stopCount: number): string | null {
  if (!speedsAvailable) return "Speed unavailable: the scenario list did not load."
  if (!state) return "Speed unavailable: no scenario session."
  if (stopCount === 0) return "Speed unavailable: this session offers none of these speeds."
  return null
}

export function PlaybackBar({ state, tSeconds, speedsAvailable = true, onSend }: Props) {
  const playing = state?.status === "playing"
  const pct = `${Math.min(100, Math.max(0, (tSeconds / 120) * 100))}%`
  const progress = tickProgress(state)
  const stops = availableStops(state?.speeds)
  const tickMinutes = state?.tick_minutes ?? 5
  // A speed just sent, kept only while the session still reports the speed it had when it was sent.
  const [pending, setPending] = useState<{ x: number; from: number | undefined } | null>(null)
  const reportedSpeed = state?.speed

  useEffect(() => {
    if (pending === null) return
    const timer = setTimeout(() => setPending(null), PENDING_SPEED_MS)
    return () => clearTimeout(timer)
  }, [pending])

  const reason = speedUnavailable(state, speedsAvailable, stops.length)
  const shown = (pending && pending.from === reportedSpeed ? pending.x : reportedSpeed) ?? null
  const stopIndex = shown === null || stops.length === 0 ? 0 : nearestStop(stops.map((stop) => stop.x), shown)
  const label = reason ?? (shown === null ? "Speed not reported" : speedLabel(shown, tickMinutes))
  const stepOk = canStep(state)

  return (
    <section className="replay-panel replay-playback" aria-label="Playback">
      <div className="replay-buttons">
        <button
          className="replay-play"
          type="button"
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
          disabled={!state}
          onClick={() => onSend({ kind: "play", body: { playing: !playing } })}
        >
          {playing ? (
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1" fill="currentColor" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" fill="currentColor" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2 L13 8 L4 14 Z" fill="currentColor" /></svg>
          )}
        </button>
        <button className="replay-next" type="button" title="Next tick (.)" disabled={!stepOk}
          onClick={() => onSend({ kind: "step", body: {} })}>Next tick</button>
      </div>
      <div className="replay-tick-stack">
        <b className="replay-tick-label">{progress.label}</b>
        <div
          className="replay-tick-progress"
          role="progressbar"
          aria-label="Ticks played"
          aria-valuemin={0}
          aria-valuemax={state?.tick_count ?? undefined}
          aria-valuenow={progress.pct === null ? undefined : state?.tick_index}
        >
          <div style={{ width: `${progress.pct ?? 0}%` }} />
        </div>
        <span>Each tick is 5 minutes</span>
      </div>
      <div className="replay-track" aria-label="Seconds inside this tick">
        <div className="rail" />
        <div className="done" style={{ width: pct }} />
        <div className="notch" style={{ left: "50%" }} />
        <div className="notch-label" style={{ left: "50%" }}>1:00 retry</div>
        <div className="notch" style={{ left: "100%" }} />
        <div className="notch-label is-end" style={{ left: "100%" }}>2:00 books close</div>
        <div className="notch-label is-start" style={{ left: "0%" }}>0:00 send</div>
        <div className="head" style={{ left: pct }} />
        <div className="now" style={{ left: pct }}>{fmtClock(tSeconds)}</div>
      </div>
      <div className="replay-speed-wrap">
        <b className="replay-speed-now">{label}</b>
        <input
          className="replay-speed"
          type="range"
          aria-label="Speed"
          aria-valuetext={label}
          title="Speed ([ slower, ] faster)"
          min={0}
          max={Math.max(0, stops.length - 1)}
          step={1}
          value={stopIndex}
          disabled={reason !== null}
          onChange={(event) => {
            const stop = stops[Number(event.target.value)]
            if (!stop || stop.x === shown) return
            setPending({ x: stop.x, from: reportedSpeed })
            onSend({ kind: "speed", body: { x: stop.x } })
          }}
        />
        <span className="replay-clock">{state?.tick?.ts ? fmtScenarioTime(state.tick.ts) : "Scenario time not reported"}</span>
        <span className="replay-keys">
          <span>Keys: Space play or pause</span> · <span>[ slower</span> · <span>] faster</span> · <span>. next tick</span>
        </span>
      </div>
    </section>
  )
}

function nearestStop(stops: number[], speed: number): number {
  let best = 0
  stops.forEach((x, index) => {
    if (Math.abs(Math.log(x / speed)) < Math.abs(Math.log(stops[best] / speed))) best = index
  })
  return best
}
