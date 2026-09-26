import { HomeCell } from "./HomeCell"
import { HOME_STATES, type FleetCounts } from "../organisms/fleetCells"

type FleetLegendProps = {
  counts: FleetCounts
  sampleNote?: string | null
}

/** Compact key for the map dots. Counts are this tick’s fleetCounts reading. A zero row is hidden so a new state reads as news. */
export function FleetLegend({ counts, sampleNote = null }: FleetLegendProps) {
  const rows = HOME_STATES.map((state) => ({ state, count: counts[state] })).filter((row) => row.count > 0)
  if (rows.length === 0) {
    return null
  }
  return (
    <div className="fleet-legend" role="list" aria-label="Home states">
      {rows.map(({ state, count }) => (
        <span key={state} className="fleet-legend-item" role="listitem">
          <HomeCell state={state} decorative />
          <span>
            {state} {count}
          </span>
        </span>
      ))}
      {sampleNote === null ? null : (
        <span className="fleet-legend-item" role="listitem">
          {sampleNote}
        </span>
      )}
    </div>
  )
}
