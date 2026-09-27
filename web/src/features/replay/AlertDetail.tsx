import type { ActiveAlert, FlowCounty, FlowTick, JevDecision, JevReading } from "../flow/types"
import { alertCountyRows, fmtScenarioTime, jevFloorText, reasonLabel, type AlertCountyRow } from "../flow/flowMath"
import { DataRow } from "./DataRow"
import { NOT_REPORTED } from "./format"
import { utcClock } from "./SessionLog"

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

/** What the reading alone asks of the county (scenario.py jev_decision): "yes: storm reserve". */
const DECISION_LEAD: Record<JevDecision, string> = {
  raise: "yes",
  keep_base: "no",
  raise_no_reading: "no reading",
}

function decisionText(decision: JevDecision): string {
  return `${DECISION_LEAD[decision] ?? decision}: ${jevFloorText(decision, undefined)}`
}

/**
 * The county's floor on this tick, from the tick itself (a fleet-wide reason can outrank JEV).
 * The tick carries no county floor once the alert has expired, or before the tick it applies from.
 */
function floorThisTick(row: AlertCountyRow, tick: FlowTick | null): string {
  if (!tick) return "No tick played yet"
  const pct = tick.county_reserve_pct?.[row.fips]
  if (typeof pct === "number") return `${pct}% · ${reasonLabel(tick.county_reasons?.[row.fips])}`
  const zonePct = tick.zone_reserve_pct[row.zone]
  return typeof zonePct === "number" ? `Alert not in force this tick · zone floor ${zonePct}%` : "Alert not in force this tick"
}

function sameReading(a: JevReading | null, b: JevReading | null): boolean {
  return !!a && !!b && a.called_at === b.called_at && a.input_label === b.input_label && a.probability === b.probability
}

/** The reading whose question, model and input are shown: the anchor county's, else the first county with one. */
function detailReading(alert: ActiveAlert, rows: AlertCountyRow[]): { title: string; reading: JevReading } | null {
  const anchorRow = rows.find((row) => sameReading(row.reading, alert.jev))
  if (alert.jev) {
    return { title: anchorRow ? `Anchor county: ${anchorRow.county_name} (${anchorRow.fips})` : "Anchor county", reading: alert.jev }
  }
  const first = rows.find((row) => row.reading)
  return first?.reading ? { title: `Details shown for ${first.county_name} (${first.fips})`, reading: first.reading } : null
}

/** A sent archived NWS alert, and the recorded JEV reading that gates each named county's alert floor. */
export function AlertDetail({ alert, counties, tick }: Props) {
  const rows = alertCountyRows(alert, counties)
  const detail = detailReading(alert, rows)
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
      <div className="replay-jev">
        <p className="replay-jev-title">JEV reading · county floor gate</p>
        {rows.length ? (
          <table className="replay-county-table">
            <thead>
              <tr>
                <th scope="col">County</th>
                <th scope="col">P(yes)</th>
                <th scope="col">JEV</th>
                <th scope="col">Floor this tick</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.fips}>
                  <th scope="row">{`${row.county_name} (${row.fips})`}</th>
                  <td>{row.reading ? row.reading.probability.toFixed(2) : "no reading"}</td>
                  <td>{decisionText(row.decision)}</td>
                  <td>{floorThisTick(row, tick)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {detail ? (
          <>
            <p className="replay-jev-sub">{detail.title}</p>
            <dl>
              <DataRow k="Question" v={detail.reading.question} />
              <DataRow k="P(yes)" v={`${detail.reading.probability.toFixed(2)} (${detail.reading.answer})`} />
              <DataRow k="Model" v={`${detail.reading.model} · ${detail.reading.latency_ms} ms`} />
              <DataRow k="Called" v={utcClock(detail.reading.called_at)} />
              <DataRow k="Input" v={detail.reading.input_label} />
            </dl>
          </>
        ) : <p className="replay-note">No recorded JEV reading for this alert.</p>}
        <p className="replay-note">
          JEV gates each county's alert floor: P(yes) of 0.5 or more raises the county to the storm reserve, below 0.5
          keeps the base floor, and no reading keeps the storm reserve (fail safe). ERCOT HIGH or an unreadable outage
          report still raises every county. Rules still compute every order; JEV only gates these floors.
        </p>
      </div>
    </div>
  )
}
