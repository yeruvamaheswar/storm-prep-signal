import type { ActiveAlert, FlowCounty, FlowTick } from "../flow/types"
import { fmtScenarioTime, namedCountyRows, reasonLabel } from "../flow/flowMath"
import { DataRow } from "./DataRow"
import { NOT_REPORTED } from "./format"

type Props = {
  alert: ActiveAlert
  /** The session's county roster (state.counties), for roster order. */
  counties: FlowCounty[]
  /** The tick on screen, whose county_reserve_pct / county_reasons say what each county's floor is now. */
  tick: FlowTick | null
}

function orMissing(text: string | undefined | null): string {
  return text && text.trim() ? text : NOT_REPORTED
}

function time(ts: string | undefined): string {
  return ts ? fmtScenarioTime(ts) : NOT_REPORTED
}

type CountyRow = FlowCounty & { named: boolean }

/** Every roster county in the alert's zones, roster order; named means the alert names it (alert.named_counties). */
function countyRows(alert: ActiveAlert, counties: FlowCounty[]): CountyRow[] {
  const named = new Set(namedCountyRows(alert).map((county) => county.fips))
  return counties
    .filter((county) => alert.zones.includes(county.zone))
    .map((county) => ({ ...county, named: named.has(county.fips) }))
}

/**
 * The county's floor on this tick, from the tick itself (a fleet-wide reason can outrank the alert).
 * The tick carries no county floor once the alert has expired, or before the tick it applies from.
 */
function floorThisTick(row: CountyRow, tick: FlowTick | null): string {
  if (!tick) return "No tick played yet"
  const pct = tick.county_reserve_pct?.[row.fips]
  if (typeof pct === "number") return `${pct}% · ${reasonLabel(tick.county_reasons?.[row.fips])}`
  const zonePct = tick.zone_reserve_pct[row.zone]
  return typeof zonePct === "number" ? `Alert not in force this tick · zone floor ${zonePct}%` : "Alert not in force this tick"
}

/** A sent archived NWS alert, and the floor each county of its zones keeps this tick. */
export function AlertDetail({ alert, counties, tick }: Props) {
  const rows = countyRows(alert, counties)
  return (
    <div className="replay-alert">
      <b>{alert.event ?? alert.id}</b>
      <p>{alert.headline ?? "No headline reported"}</p>
      <dl>
        <DataRow k="Area" v={orMissing(alert.areaDesc)} />
        <DataRow k="County codes (NWS SAME)" v={orMissing((alert.counties ?? []).join(", "))} />
        <DataRow k="Mapped to zone" v={orMissing(alert.zones.join(", "))} />
        <DataRow k="Onset" v={time(alert.onset)} />
        <DataRow k="Expires" v={time(alert.expires)} />
        {/* The worker records no tick when the alert arrives after the tape's last frame. */}
        <DataRow k="Sent at tick" v={alert.sent_at_tick ?? "After the last tick"} />
        <DataRow k="Source" v={alert.source_url
          ? <a href={alert.source_url} target="_blank" rel="noreferrer">{alert.source_label ?? "Archived NWS alert"}</a>
          : NOT_REPORTED} />
      </dl>
      <div className="replay-alert-counties">
        <p className="replay-alert-counties-title">Counties in this alert's zones</p>
        {rows.length ? (
          <table className="replay-county-table">
            <thead>
              <tr>
                <th scope="col">County</th>
                <th scope="col">Named in alert</th>
                <th scope="col">Floor this tick</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.fips}>
                  <th scope="row">{`${row.name} (${row.fips})`}</th>
                  <td>{row.named ? "Named in alert" : "Not named"}</td>
                  <td>{floorThisTick(row, tick)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="replay-note">No roster county in this alert's zones.</p>}
        <p className="replay-note">
          Every county this alert names keeps the storm reserve, whatever the alert type; the zone's other counties keep
          the base floor. ERCOT HIGH or an unreadable outage report still raises every county.
        </p>
      </div>
    </div>
  )
}
