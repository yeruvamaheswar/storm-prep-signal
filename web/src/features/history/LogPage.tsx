import type { LogPageProps, StressLevel, Tick, TickSource } from "./types"
import "./history.css"

function formatMw(value: number): string {
  return value.toFixed(2)
}

function formatPrice(value: number): string {
  return value.toFixed(0)
}

function formatTime(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) {
    return ts
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "America/Chicago",
    timeZoneName: "short",
  }).format(date)
}

function stressName(level: StressLevel | null): string {
  switch (level) {
    case "LOW":
    case "HIGH":
      return level
    case null:
      return "—"
    default: {
      const neverLevel: never = level
      return neverLevel
    }
  }
}

function playbackMark(source: TickSource): string | null {
  switch (source) {
    case "playback":
      return "PLAYBACK"
    case "live":
      return null
    default: {
      const neverSource: never = source
      return neverSource
    }
  }
}

export function LogPage({ ticks, selectedTickId, onSelect }: LogPageProps) {
  const selected = ticks.find((tick) => tick.tick_id === selectedTickId) ?? null

  return (
    <section className="history-page" aria-labelledby="history-log-title">
      <header className="history-mast">
        <h1 id="history-log-title">Log</h1>
      </header>
      <div className="history-table-wrap">
        <table className="history-table">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Mode</th>
              <th scope="col">Target</th>
              <th scope="col">Delivered</th>
              <th scope="col">Missed</th>
              <th scope="col">Price</th>
              <th scope="col">Stress level</th>
              <th scope="col">Quality</th>
              <th scope="col">Breaches</th>
              <th scope="col">Calm streak</th>
            </tr>
          </thead>
          <tbody>
            {ticks.map((tick) => (
              <LogRow
                key={tick.tick_id}
                tick={tick}
                selected={tick.tick_id === selectedTickId}
                onSelect={onSelect}
              />
            ))}
          </tbody>
        </table>
      </div>
      {selected === null ? (
        <p className="history-note">Select a tick to read its brief and reasons.</p>
      ) : (
        <TickDetail tick={selected} />
      )}
    </section>
  )
}

function LogRow({
  tick,
  selected,
  onSelect,
}: {
  tick: Tick
  selected: boolean
  onSelect: (tickId: string) => void
}) {
  const mark = playbackMark(tick.source)
  const rowClass = selected ? "history-row history-row-selected" : "history-row"

  return (
    <tr
      className={rowClass}
      aria-selected={selected}
      tabIndex={0}
      onClick={() => onSelect(tick.tick_id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect(tick.tick_id)
        }
      }}
    >
      <td>
        <span className="history-time">{formatTime(tick.ts)}</span>
        {mark === null ? null : <span className="history-mark">{mark}</span>}
      </td>
      <td>{tick.mode}</td>
      <td>
        <span className="history-num">{formatMw(tick.target.mw)}</span>
        <span className="history-unit">MW</span>
      </td>
      <td>
        <span className="history-num">{formatMw(tick.delivered_mw)}</span>
        <span className="history-unit">MW</span>
      </td>
      <td>
        <span className="history-num">{formatMw(tick.missed_mw)}</span>
        <span className="history-unit">MW</span>
      </td>
      <td>
        <span className="history-num">{formatPrice(tick.price.usd_mwh)}</span>
        <span className="history-unit">$/MWh</span>
      </td>
      <td>{stressName(tick.stress.level)}</td>
      <td>{tick.quality}</td>
      <td className="history-num">{tick.fleet.breaches}</td>
      <td className="history-num">{tick.stress.calm_streak}</td>
    </tr>
  )
}

function TickDetail({ tick }: { tick: Tick }) {
  return (
    <div className="history-detail">
      <h2 className="history-detail-title">Brief</h2>
      <p className="history-brief">{tick.brief}</p>
      <h2 className="history-detail-title">Reasons</h2>
      {tick.reasons.length === 0 ? (
        <p className="history-note">No reasons on this tick.</p>
      ) : (
        <ul className="history-reasons">
          {tick.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
