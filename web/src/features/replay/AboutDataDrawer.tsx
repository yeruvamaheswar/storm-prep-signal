import type { ReactNode } from "react"
import { VerifyArchive } from "../flow/VerifyArchive"
import { FLOW_ZONES, type ActiveAlert, type SessionState, type StartSummary } from "../flow/types"
import { fmtScenarioTime, fmtUsd } from "../flow/flowMath"

type Props = {
  state: SessionState
  onClose: () => void
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="replay-data-row">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  )
}

function hasStart(start: SessionState["start"]): start is StartSummary {
  return typeof (start as StartSummary).seed === "number"
}

function StartHistogram({ start }: { start: StartSummary }) {
  const peak = Math.max(1, ...start.histogram)
  return (
    <div className="replay-hist" aria-label="Starting charge histogram">
      {start.histogram.map((count, index) => (
        <span key={index} title={`${count} homes`} style={{ height: `${(count / peak) * 100}%` }} />
      ))}
    </div>
  )
}

function AlertRows({ alert }: { alert: ActiveAlert }) {
  return (
    <div className="replay-alert">
      <b>{alert.event ?? alert.id}</b>
      <p>{alert.headline ?? "No headline reported"}</p>
      <dl>
        <Row k="Zones" v={alert.zones.join(", ") || "Not reported"} />
        <Row k="Expires" v={fmtScenarioTime(alert.expires)} />
      </dl>
      <p className="replay-note">JEV shadow reading, never dispatches.</p>
      {alert.jev ? <p>{alert.jev.answer} · P(threat) {alert.jev.probability.toFixed(2)}</p> : <p className="replay-note">No recorded JEV reading.</p>}
    </div>
  )
}

export function AboutDataDrawer({ state, onClose }: Props) {
  const provenance = state.provenance
  return (
    <section className="replay-panel replay-data" aria-label="About this data">
      <div className="replay-ledger-head">
        <div>
          <h2>About this data</h2>
          <p>Archive rows and limits used by the scenario worker.</p>
        </div>
        <button className="replay-pill" type="button" onClick={onClose}>Close</button>
      </div>
      <section>
        <h3>Provenance</h3>
        {provenance ? (
          <dl>
            <Row k="Tick clock" v={fmtScenarioTime(provenance.ts)} />
            <Row k="Outage report" v={provenance.posting ? `${provenance.posting.report} · ${provenance.posting.file}` : "Not reported"} />
            <Row k="Posted" v={provenance.posting?.posted_at ?? "Not reported"} />
            <Row k="Target" v={`${provenance.target.mw.toFixed(3)} MW · ${provenance.target.label}`} />
            {FLOW_ZONES.map((zone) => <Row key={zone} k={`${zone} price`} v={fmtUsd(provenance.zone_prices.zones[zone])} />)}
          </dl>
        ) : <p className="replay-note">No provenance reported yet.</p>}
        <VerifyArchive state={state} />
      </section>
      <section>
        <h3>Alerts</h3>
        {state.alerts.length ? state.alerts.map((alert) => <AlertRows key={alert.id} alert={alert} />) : <p className="replay-note">No alert sent in this session.</p>}
      </section>
      <section>
        <h3>Honest limits</h3>
        <ul>{state.honest_limits.map((line) => <li key={line}>{line}</li>)}</ul>
      </section>
      <section>
        <h3>Starting charge</h3>
        {hasStart(state.start) ? <StartHistogram start={state.start} /> : <p className="replay-note">No seeded fleet reported.</p>}
      </section>
    </section>
  )
}
