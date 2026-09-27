import type { CSSProperties } from "react"
import { BATTERY_COLOR, BATTERY_LABEL, chargeSpeedCaption, fmtKw, fmtMw, reasonLabel } from "./flowMath"
import type { BatteryState, FlowHome, FlowZoneRow } from "./types"

type Props = {
  zone: string
  row: FlowZoneRow | undefined
  homes: FlowHome[]
  stepSeconds: number
  pack: { kwh: number; kw: number } | null
  onClose: () => void
}

const UNDER_FLOOR_WHY = {
  started_under: "Started under it (random draw)",
  floor_raised: "Floor raised above their charge",
} as const

const LEGEND: BatteryState[] = ["selling", "charging", "holding", "reserved", "at_floor", "below_floor", "islanded", "unconfirmed", "stale", "dead"]

/** One cell per battery. The fill moves to the new charge over one playback step (real kW, sped up). */
export function ZoneBatteries({ zone, row, homes, stepSeconds, pack, onClose }: Props) {
  const inZone = homes.filter((home) => home.zone === zone)
  const present = new Set(inZone.map((home) => home.state))
  const startedUnder = inZone.filter((home) => home.under_floor_why === "started_under").length
  const floorRaised = inZone.filter((home) => home.under_floor_why === "floor_raised").length
  const fillStyle = { "--flow-step": `${Math.max(0.1, stepSeconds * 0.9).toFixed(2)}s` } as CSSProperties
  return (
    <section className="flow-zone-panel" aria-label={`${zone} batteries`} style={fillStyle}>
      <header className="flow-zone-head">
        <h2>{zone} batteries</h2>
        <p className="flow-muted">
          {row
            ? `sell ${fmtMw(row.selling_mw)} · charge ${fmtMw(row.charging_mw)} · floor ${row.reserve_pct}% (${reasonLabel(row.reason)})`
            : "No tick played yet."}
        </p>
        <button type="button" className="flow-button" onClick={onClose}>All zones</button>
      </header>
      {row?.grid_down ? (
        <p className="flow-banner is-down">
          Grid down in {zone} (operator overlay, not archive data). These batteries back up their own homes: they neither sell nor charge.
        </p>
      ) : null}
      <div className="flow-cells">
        {inZone.map((home) => (
          <div key={home.id} className={`flow-cell is-${home.state}`}
            title={`${home.id}: ${home.soc_pct.toFixed(1)}% · ${fmtKw(home.kw)} · ${BATTERY_LABEL[home.state]} · floor ${home.floor_pct}%` +
              (home.under_floor_why ? ` · ${UNDER_FLOOR_WHY[home.under_floor_why]}` : "")}>
            <div className="flow-cell-tank">
              <span className="flow-cell-fill" style={{ height: `${home.soc_pct}%`, background: BATTERY_COLOR[home.state] }} />
              <span className="flow-cell-floor" style={{ bottom: `${home.floor_pct}%` }} />
            </div>
            <span className="flow-cell-pct">{home.soc_pct.toFixed(0)}%</span>
            <span className="flow-cell-kw">{fmtKw(home.kw)}</span>
          </div>
        ))}
      </div>
      <ul className="flow-legend">
        {LEGEND.filter((state) => present.has(state)).map((state) => (
          <li key={state}><span className="flow-swatch" style={{ background: BATTERY_COLOR[state] }} />{BATTERY_LABEL[state]}</li>
        ))}
        <li><span className="flow-swatch flow-swatch-floor" />Floor line</li>
      </ul>
      {startedUnder || floorRaised ? (
        <p className="flow-muted">
          No battery is ever sold below its floor. Under the floor now: {startedUnder} {UNDER_FLOOR_WHY.started_under.toLowerCase()},{" "}
          {floorRaised} {UNDER_FLOOR_WHY.floor_raised.toLowerCase()}.
        </p>
      ) : null}
      {pack ? <p className="flow-muted">{chargeSpeedCaption(pack.kwh, pack.kw)}</p> : null}
    </section>
  )
}
