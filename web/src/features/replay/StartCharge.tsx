import { FLOW_ZONES, type StartSummary } from "../flow/types"
import { chargeSpeedCaption } from "../flow/flowMath"
import { DataRow } from "./DataRow"

type Bin = { low: number; high: number; count: number; under: boolean }

/** Each bin's range and count. A bin is "under" only when its whole range sits under the base floor,
 * so a bin that straddles the floor is not marked. */
function bins(start: StartSummary): Bin[] {
  const width = 100 / start.histogram.length
  return start.histogram.map((count, index) => {
    const low = index * width
    const high = low + width
    return { low, high, count, under: high <= start.base_floor_pct }
  })
}

/** Bars of starting charge. The accessible name carries every bin's count, since the bars are visual only. */
function Histogram({ start }: { start: StartSummary }) {
  const all = bins(start)
  const peak = Math.max(1, ...start.histogram)
  const label = `Starting charge of ${start.homes} batteries: ${all.map((bin) => `${bin.low} to ${bin.high}%: ${bin.count}`).join(", ")}`
  return (
    <div className="replay-hist" role="img" aria-label={label}>
      {all.map((bin) => (
        <div key={bin.low} className="replay-hist-bin" title={`${bin.low} to ${bin.high}%: ${bin.count} batteries`}>
          <span className={bin.under ? "replay-hist-bar is-under" : "replay-hist-bar"} style={{ height: `${(bin.count / peak) * 100}%` }} />
          <span className="replay-hist-label">{bin.low}</span>
        </div>
      ))}
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
      <p className="replay-note">Bins are starting charge in %. Amber bins lie wholly under the {start.base_floor_pct}% base floor.</p>
      {caption ? <p className="replay-note">{caption}</p> : null}
    </>
  )
}
