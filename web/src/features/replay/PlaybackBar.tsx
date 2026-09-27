import type { FlowRequest } from "../flow/api"
import { fmtScenarioTime } from "../flow/flowMath"
import type { SessionState } from "../flow/types"
import { fmtClock } from "./tickClock"

type Props = {
  state: SessionState | null
  tSeconds: number
  /** False when the scenario catalog (and so the session speeds) could not be fetched. */
  speedsAvailable?: boolean
  onSend: (request: FlowRequest) => void
}

const SPEEDS: Array<{ label: string; x: 15 | 60 | 300 }> = [
  { label: "Watch orders", x: 15 },
  { label: "Fast", x: 60 },
  { label: "Time-lapse", x: 300 },
]

/** "Tick N of M" and the share of the run played, from the session's own counters. Null when not reported. */
export function tickProgress(state: Pick<SessionState, "tick_index" | "tick_count"> | null): { label: string; pct: number | null } {
  const index = state?.tick_index
  const total = state?.tick_count
  if (typeof index !== "number" || typeof total !== "number" || !(total > 0)) return { label: "Tick not reported", pct: null }
  return { label: `Tick ${index} of ${total}`, pct: Math.min(100, Math.max(0, (index / total) * 100)) }
}

export function PlaybackBar({ state, tSeconds, speedsAvailable = true, onSend }: Props) {
  const playing = state?.status === "playing"
  const pct = `${Math.min(100, Math.max(0, (tSeconds / 120) * 100))}%`
  const progress = tickProgress(state)
  const sessionSpeeds = state?.speeds ?? []
  return (
    <section className="replay-panel replay-playback" aria-label="Playback">
      <button
        className="replay-play"
        type="button"
        aria-label={playing ? "Pause" : "Play"}
        disabled={!state}
        onClick={() => onSend({ kind: "play", body: { playing: !playing } })}
      >
        {playing ? (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1" fill="currentColor" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" fill="currentColor" /></svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2 L13 8 L4 14 Z" fill="currentColor" /></svg>
        )}
      </button>
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
        <div className="replay-seg" role="group" aria-label="Speed">
          {SPEEDS.map((speed) => (
            <button key={speed.x} type="button" className={state?.speed === speed.x ? "on" : undefined}
              aria-pressed={state?.speed === speed.x}
              disabled={!speedsAvailable || !state || !sessionSpeeds.includes(speed.x)}
              onClick={() => onSend({ kind: "speed", body: { x: speed.x } })}>
              {speed.label}
            </button>
          ))}
        </div>
        <span className="replay-clock">{state?.tick?.ts ? fmtScenarioTime(state.tick.ts) : "Scenario time not reported"}</span>
      </div>
    </section>
  )
}
