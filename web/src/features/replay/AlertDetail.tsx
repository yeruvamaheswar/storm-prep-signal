import type { ActiveAlert, FlowTick, NamedCounty } from "../flow/types"
import { fmtScenarioTime, namedCountyRows, reasonLabel } from "../flow/flowMath"
import { DataRow } from "./DataRow"
import { NOT_REPORTED } from "./format"

type Props = {
  alert: ActiveAlert
  /** The tick on screen, whose county_reserve_pct / county_reasons say what each county's floor is now. */
  tick: FlowTick | null
}

function orMissing(text: string | undefined | null): string {
  return text && text.trim() ? text : NOT_REPORTED
}

function time(ts: string | undefined): string {
  return ts ? fmtScenarioTime(ts) : NOT_REPORTED
}

/**
 * The county's floor on this tick, from the tick itself (a fleet-wide reason can outrank the alert).
 * The tick carries no county floor once the alert has expired, or before the tick it applies from.
 */
function floorThisTick(row: NamedCounty, tick: FlowTick | null): string {
  if (!tick) return "No tick played yet"
  const pct = tick.county_reserve_pct?.[row.fips]
  if (typeof pct === "number") return `${pct}% · ${reasonLabel(tick.county_reasons?.[row.fips])}`
  const zonePct = tick.zone_reserve_pct[row.zone]
  return typeof zonePct === "number" ? `Alert not in force this tick · zone floor ${zonePct}%` : "Alert not in force this tick"
}

/** A sent archived NWS alert, and the roster counties it names: each keeps the storm reserve while it is in force. */
export function AlertDetail({ alert, tick }: Props) {
  const rows = namedCountyRows(alert)
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
      <div className="replay-named">
        <p className="replay-named-title">Counties named in this alert</p>
        {rows.length ? (
          <table className="replay-county-table">
            <thead>
              <tr>
                <th scope="col">County</th>
                <th scope="col">Zone</th>
                <th scope="col">Floor this tick</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.fips}>
                  <th scope="row">{`${row.county_name} (${row.fips})`}</th>
                  <td>{row.zone}</td>
                  <td>{floorThisTick(row, tick)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="replay-note">The alert names no roster county.</p>}
        <p className="replay-note">
          A county the alert names keeps the storm reserve; other counties in the zone keep the base floor. ERCOT HIGH
          or an unreadable outage report still raises every county.
        </p>
      </div>
    </div>
  )
}
