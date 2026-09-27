import type { FlowRequest } from "../flow/api"
import { fmtScenarioTime } from "../flow/flowMath"
import type { SessionState } from "../flow/types"
import { fmtClock } from "./tickClock"

type Props = {
  state: SessionState | null
  tSeconds: number
  onSend: (request: FlowRequest) => void
}

const SPEEDS: Array<{ label: string; x: 15 | 60 | 300 }> = [
  { label: "Watch orders", x: 15 },
  { label: "Fast", x: 60 },
  { label: "Time-lapse", x: 300 },
]

export function PlaybackBar({ state, tSeconds, onSend }: Props) {
  const playing = state?.status === "playing"
  const pct = `${Math.min(100, Math.max(0, (tSeconds / 120) * 100))}%`
  const ticks = Array.from({ length: Math.max(4, state?.tick_count ?? 4) }, (_, i) => i + 1)
  return (
    <section className="replay-panel replay-playback" aria-label="Playback">
      <button
        className="replay-play"
        type="button"
        aria-label={playing ? "Pause" : "Play"}
        disabled={!state}
        onClick={() => onSend({ kind: "play", body: { playing: !playing } })}
      >
        {playing ? "Ⅱ" : "▶"}
      </button>
      <div className="replay-tick-stack">
        <div className="replay-seg" role="group" aria-label="Tick">
          {ticks.slice(0, 6).map((tick) => <button key={tick} type="button" className={tick === state?.tick_index ? "on" : undefined}>{tick}</button>)}
        </div>
        <span>Each tick is 5 minutes</span>
      </div>
      <div className="replay-track" aria-label="Seconds inside this tick">
        <div className="rail" />
        <div className="done" style={{ width: pct }} />
        <div className="notch" style={{ left: "50%" }} />
        <div className="notch-label" style={{ left: "50%" }}>1:00 retry</div>
        <div className="notch" style={{ left: "100%" }} />
        <div className="notch-label" style={{ left: "96%" }}>2:00 books close</div>
        <div className="notch-label" style={{ left: "2%" }}>0:00 send</div>
        <div className="head" style={{ left: pct }} />
        <div className="now" style={{ left: pct }}>{fmtClock(tSeconds)}</div>
      </div>
      <div className="replay-speed-wrap">
        <div className="replay-seg" role="group" aria-label="Speed">
          {SPEEDS.map((speed) => (
            <button key={speed.x} type="button" className={state?.speed === speed.x ? "on" : undefined}
              onClick={() => onSend({ kind: "speed", body: { x: speed.x } })}>
              {speed.label}
            </button>
          ))}
        </div>
        <span>{fmtScenarioTime(state?.tick?.ts)} · Tick {state?.tick_index ?? "n/a"} of {state?.tick_count ?? "n/a"}</span>
      </div>
    </section>
  )
}
