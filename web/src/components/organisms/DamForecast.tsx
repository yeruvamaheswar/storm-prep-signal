import type { TickView } from "../../contracts"
import { damForecast, usdMwh, type DamRow } from "../../damForecast"

/** Cells per row. A shorter window leaves the right side empty so hours line up across zones. */
const WINDOW_HOURS = 24

type DamForecastProps = {
  tick: TickView | null
}

export function DamForecast({ tick }: DamForecastProps) {
  const forecast = damForecast(tick)
  if (forecast === null) return null
  return (
    <section className="dam" aria-label="Next 24 h price">
      <p className="dam-title">Next 24 h price (ERCOT DAM, $/MWh)</p>
      <p className="tape-caption">
        <span className="dam-swatch">Charge hour</span>
        <span className="dam-swatch dam-swatch-now">Now</span>
        <span className="dam-swatch dam-swatch-peak">Zone high</span>
        {forecast.asOf === null ? null : <span>Delivery {forecast.asOf.split(",").join(", ")}</span>}
      </p>
      <div className="dam-rows">
        {forecast.rows.map((row) => (
          <DamBars key={row.zone} row={row} priceLabel={forecast.priceLabel} />
        ))}
      </div>
      <ul className="dam-lines">
        {forecast.rows.map((row) => (
          <li key={row.zone}>{row.line}</li>
        ))}
      </ul>
    </section>
  )
}

function DamBars({ row, priceLabel }: { row: DamRow; priceLabel: string }) {
  const first = row.cells[0]?.label ?? ""
  const summary = `${row.zone}: ${String(row.cells.length)} hours from ${first}, high ${usdMwh(row.peakUsdMwh)} ${priceLabel}`
  return (
    <>
      <span className="dam-zone">{row.zone}</span>
      <svg
        className="dam-bars"
        viewBox={`0 0 ${String(WINDOW_HOURS)} 100`}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
      >
        {row.cells.map((cell, index) => (
          <rect
            key={cell.hourStart}
            className={cell.charge ? "dam-bar is-charge" : "dam-bar"}
            x={index + 0.1}
            width={0.8}
            y={100 - cell.heightPct}
            height={cell.heightPct}
          >
            <title>{`${cell.label} ${usdMwh(cell.usdMwh)} ${priceLabel}`}</title>
          </rect>
        ))}
        <line className="dam-peak" x1={0} x2={row.cells.length} y1={100 - row.peakPct} y2={100 - row.peakPct} />
        {row.cells.map((cell, index) =>
          cell.now ? <rect key="now" className="dam-now" x={index} y={0} width={1} height={100} /> : null,
        )}
      </svg>
    </>
  )
}
