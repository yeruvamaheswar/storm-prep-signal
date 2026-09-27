import type { ReactNode } from "react"
import { alertCountyRows, fmtMw, fmtScenarioTime, fmtUsd, reasonLabel } from "./flowMath"
import type { ActiveAlert, FlowTick, SessionState, StartSummary } from "./types"
import { FLOW_ZONES } from "./types"

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flow-section">
      <h2 className="flow-section-title">{title}</h2>
      {children}
    </section>
  )
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flow-row">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  )
}

function hasStart(start: SessionState["start"]): start is StartSummary {
  return typeof (start as StartSummary).seed === "number"
}

function Histogram({ start }: { start: StartSummary }) {
  const peak = Math.max(1, ...start.histogram)
  const bins = start.histogram.length
  return (
    <div className="flow-hist" aria-label="Starting charge histogram">
      {start.histogram.map((count, i) => {
        const low = (i * 100) / bins
        const underFloor = low < start.base_floor_pct
        return (
          <div key={low} className="flow-hist-bin" title={`${low}–${low + 100 / bins}%: ${count} batteries`}>
            <span className={underFloor ? "flow-hist-bar is-under" : "flow-hist-bar"}
              style={{ height: `${(count / peak) * 100}%` }} />
            <span className="flow-hist-label">{low}</span>
          </div>
        )
      })}
    </div>
  )
}

function StartBlock({ start }: { start: StartSummary }) {
  const under = FLOW_ZONES.map((zone) => `${zone} ${start.below_base_floor[zone] ?? 0}`).join(" · ")
  return (
    <>
      <dl>
        <Row k="Seed" v={start.seed} />
        <Row k="Draw" v={`uniform ${start.range_pct[0]}–${start.range_pct[1]}% of ${start.pack.kwh} kWh`} />
        <Row k="Range" v={`${start.min_pct}% to ${start.max_pct}% (mean ${start.mean_pct}%)`} />
        <Row k={`Under ${start.base_floor_pct}% floor`} v={under} />
        <Row k="Pack" v={`${start.pack.kwh} kWh · ${start.pack.kw} kW (example, not Base specs)`} />
      </dl>
      <Histogram start={start} />
    </>
  )
}

function AlertBlock({ alert, tick }: { alert: ActiveAlert; tick: FlowTick | null }) {
  const rows = alertCountyRows(alert)
  return (
    <div className="flow-alert">
      <p className="flow-alert-event">{alert.event}</p>
      <p className="flow-alert-headline">{alert.headline}</p>
      <dl>
        <Row k="Area" v={alert.areaDesc ?? "n/a"} />
        <Row k="Counties (FIPS)" v={(alert.counties ?? []).join(", ") || "n/a"} />
        <Row k="Mapped to zone" v={alert.zones.join(", ")} />
        <Row k="Onset" v={fmtScenarioTime(alert.onset)} />
        <Row k="Expires" v={fmtScenarioTime(alert.expires)} />
        <Row k="Sent at tick" v={alert.sent_at_tick ?? "end"} />
        <Row k="Source" v={alert.source_url
          ? <a href={alert.source_url} target="_blank" rel="noreferrer">{alert.source_label ?? "archived NWS alert"}</a>
          : "n/a"} />
      </dl>
      <div className="flow-named">
        <p className="flow-named-title">Counties named in this alert</p>
        {rows.length ? (
          <table className="flow-county-table">
            <thead>
              <tr><th>County</th><th>Zone</th><th>Floor</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const pct = tick?.county_reserve_pct?.[row.fips]
                return (
                  <tr key={row.fips}>
                    <td>{row.county_name}</td>
                    <td>{row.zone}</td>
                    <td>{typeof pct === "number" ? `${pct}%` : "storm reserve"}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <p className="flow-muted">The alert names no roster county.</p>
        )}
        <p className="flow-muted">
          A county the alert names keeps the storm reserve; other counties in the zone keep the base floor.
        </p>
      </div>
    </div>
  )
}

type Props = {
  state: SessionState
  verify: ReactNode
}

export function DataPanel({ state, verify }: Props) {
  const prov = state.provenance
  const tick = state.tick
  return (
    <aside className="flow-panel" aria-label="Data in use">
      <Section title="Scenario">
        {state.scenario ? (
          <dl>
            <Row k="Name" v={state.scenario.name} />
            <Row k="Window" v={state.scenario.window ?? "n/a"} />
            <Row k="Label" v={state.scenario.label ?? "n/a"} />
            <Row k="Tape" v={<code>{state.scenario.tape}</code>} />
            <Row k="Baseline" v={<code>{state.scenario.baseline}</code>} />
            {state.scenario.summary ? <p className="flow-muted">{state.scenario.summary}</p> : null}
          </dl>
        ) : <p className="flow-muted">Pick a scenario.</p>}
      </Section>

      <Section title={prov ? `Archive rows · tick ${prov.tick} · ${fmtScenarioTime(prov.ts)}` : "Archive rows"}>
        {prov ? (
          <dl>
            {prov.posting ? (
              <>
                <Row k="Outage report" v={`${prov.posting.report} · ${prov.posting.table}`} />
                <Row k="Posted" v={prov.posting.posted_at ?? "n/a"} />
                <Row k="Rows" v={prov.posting.rows} />
                <Row k="File" v={<code>{prov.posting.file}</code>} />
              </>
            ) : <Row k="Outage report" v="none on this tick: risk unknown, fail safe" />}
            {prov.archive_rows?.posting?.id !== undefined ? (
              <Row k="Supabase row" v={`ercot_postings.id ${prov.archive_rows.posting.id}${prov.archive_rows.posting.file_name ? ` · ${prov.archive_rows.posting.file_name}` : ""}`} />
            ) : null}
            {prov.rating ? (
              <Row k="Rule reading" v={`${prov.rating.level}: peak ${prov.rating.peak_mw.toLocaleString()} MW at HE${prov.rating.peak_hour} vs trigger ${Math.round(prov.rating.trigger_mw).toLocaleString()} MW (typical ${Math.round(prov.rating.baseline_mw).toLocaleString()} MW +15%)`} />
            ) : null}
            <Row k="Zone prices" v={prov.zone_prices.label} />
            {FLOW_ZONES.map((zone) => (
              <Row key={zone} k={`  ${zone}`} v={fmtUsd(prov.zone_prices.zones[zone])} />
            ))}
            {prov.archive_rows?.prices?.length ? (
              <Row k="Price rows" v={prov.archive_rows.prices.map((p) => `${p.settlement_point} ${p.interval_ending}`).join(" · ")} />
            ) : null}
            <Row k="Grid ask" v={`${fmtMw(prov.target.mw)} · ${prov.target.label}`} />
            <Row k="Baseline" v={`${prov.baseline.postings ?? "?"} postings, ${prov.baseline.from ?? "?"} to ${prov.baseline.to ?? "?"}`} />
            {prov.archive_rows?.overlay ? <Row k="Overlay" v={prov.archive_rows.overlay} /> : null}
          </dl>
        ) : <p className="flow-muted">No tick played yet.</p>}
        {verify}
      </Section>

      <Section title="Batteries at start">
        {hasStart(state.start) ? <StartBlock start={state.start} /> : <p className="flow-muted">No fleet seeded yet.</p>}
      </Section>

      <Section title="Engine decision this tick">
        {tick ? (
          <dl>
            {FLOW_ZONES.map((zone) => (
              <Row key={zone} k={`${zone} floor`} v={`${tick.zone_reserve_pct[zone] ?? tick.reserve_pct}% · ${reasonLabel(tick.zone_reasons[zone] ?? tick.policy_reason)}`} />
            ))}
            <Row k="Intent" v={`${tick.intent}${tick.intent_reason ? ` (${tick.intent_reason})` : ""}`} />
            <Row k="Mode" v={tick.mode} />
            <Row k="Reasons" v={tick.reasons.length ? tick.reasons.join(", ") : "none"} />
            <Row k="Breaches" v={tick.breaches} />
            <p className="flow-brief">{tick.brief}</p>
          </dl>
        ) : <p className="flow-muted">Press play.</p>}
      </Section>

      <Section title="Weather alerts sent">
        {state.alerts.length ? state.alerts.map((alert) => (
          <AlertBlock key={alert.id} alert={alert} tick={tick} />
        ))
          : <p className="flow-muted">None. Use Send alert to push an archived NWS alert into the next tick.</p>}
      </Section>

      <Section title="Overlays (hand-placed)">
        {prov?.archive_rows?.overlay ? <p>Tick {prov.tick}: {prov.archive_rows.overlay}</p> : null}
        {state.grid_down_zones.length
          ? <p>Grid down in {state.grid_down_zones.join(", ")}. Operator overlay, not an archive row.</p> : null}
        {!prov?.archive_rows?.overlay && !state.grid_down_zones.length ? <p className="flow-muted">None this tick.</p> : null}
      </Section>

      <Section title="Honest limits">
        <ul className="flow-limits">
          {state.honest_limits.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </Section>

      <Section title="Session log">
        <ul className="flow-log">
          {state.log.slice().reverse().map((line) => <li key={`${line.at}-${line.text}`}>{line.text}</li>)}
        </ul>
      </Section>
    </aside>
  )
}
