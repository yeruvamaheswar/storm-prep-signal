import { FLOW_ZONES, type StartSummary } from "../flow/types"
import { chargeSpeedCaption } from "../flow/flowMath"
import { DataRow } from "./DataRow"

/** Bars of starting charge; a bin whose low edge is under the base floor is marked. */
function Histogram({ start }: { start: StartSummary }) {
  const peak = Math.max(1, ...start.histogram)
  const bins = start.histogram.length
  return (
    <div className="replay-hist" aria-label="Starting charge histogram">
      {start.histogram.map((count, index) => {
        const low = (index * 100) / bins
        const high = low + 100 / bins
        const under = low < start.base_floor_pct
        return (
          <div key={low} className="replay-hist-bin" title={`${low} to ${high}%: ${count} batteries`}>
            <span className={under ? "replay-hist-bar is-under" : "replay-hist-bar"} style={{ height: `${(count / peak) * 100}%` }} />
            <span className="replay-hist-label">{low}</span>
          </div>
        )
      })}
    </div>
  )
}

/** The seeded fleet: how the starting charge was drawn, what it came to, and the pack it assumes. */
export function StartCharge({ start }: { start: StartSummary }) {
  // The worker lists only zones with at least one home under the floor, so a zone it leaves out has none.
  const under = FLOW_ZONES.map((zone) => `${zone} ${start.below_base_floor[zone] ?? 0}`).join(" · ")
  const caption = chargeSpeedCaption(start.pack.kwh, start.pack.kw)
  return (
    <>
      <dl>
        <DataRow k="Seed" v={start.seed} />
        <DataRow k="Draw" v={`uniform ${start.range_pct[0]} to ${start.range_pct[1]}% of ${start.pack.kwh} kWh`} />
        <DataRow k="Range" v={`${start.min_pct}% to ${start.max_pct}% (mean ${start.mean_pct}%)`} />
        <DataRow k={`Under ${start.base_floor_pct}% floor`} v={under} />
        <DataRow k="Pack" v={`${start.pack.kwh} kWh · ${start.pack.kw} kW (example, not Base specs)`} />
      </dl>
      <Histogram start={start} />
      <p className="replay-note">Bins are starting charge in %. Amber bins start under the {start.base_floor_pct}% base floor.</p>
      {caption ? <p className="replay-note">{caption}</p> : null}
    </>
  )
}
