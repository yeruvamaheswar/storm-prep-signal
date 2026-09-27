import { VerifyArchive } from "../flow/VerifyArchive"
import { FLOW_ZONES, type FlowTick, type Provenance, type SessionState, type StartSummary } from "../flow/types"
import { fmtScenarioTime, fmtUsd, reasonLabel } from "../flow/flowMath"
import { AlertDetail } from "./AlertDetail"
import { DataRow as Row } from "./DataRow"
import { NOT_REPORTED, mw, plainReason } from "./format"
import { SessionLog } from "./SessionLog"
import { StartCharge } from "./StartCharge"
import { useDrawerFocus } from "./useDrawer"
import { ZoneShares } from "./ZoneShares"

type Props = {
  state: SessionState
  onClose: () => void
}

function hasStart(start: SessionState["start"]): start is StartSummary {
  return typeof (start as StartSummary).seed === "number"
}

function orMissing(value: string | null | undefined): string {
  return value && value.trim() ? value : NOT_REPORTED
}

/** Mode words for the engine's two modes (server/engine/contracts.py). Any other code shows as sent. */
const MODE_WORDS: Record<string, string> = {
  AUTO: "Automatic: the engine decides",
  HOLD: "Hold: the operator paused selling",
}

function whole(value: number): string {
  return Math.round(value).toLocaleString("en-US")
}

function ruleReading(rating: NonNullable<Provenance["rating"]>): string {
  return `${rating.level}: peak ${whole(rating.peak_mw)} MW at HE${rating.peak_hour} vs trigger ${whole(rating.trigger_mw)} MW (typical ${whole(rating.baseline_mw)} MW)`
}

function baselineRange(baseline: Provenance["baseline"]): string {
  if (typeof baseline.postings !== "number") return NOT_REPORTED
  return `${baseline.postings} postings, ${orMissing(baseline.from)} to ${orMissing(baseline.to)}`
}

function ProvenanceRows({ provenance }: { provenance: Provenance }) {
  const posting = provenance.posting
  const archive = provenance.archive_rows
  return (
    <dl>
      <Row k="Tick clock" v={`Tick ${provenance.tick} · ${fmtScenarioTime(provenance.ts)}`} />
      {posting ? (
        <>
          <Row k="Outage report" v={`${posting.report} · ${posting.table}`} />
          <Row k="Posted" v={orMissing(posting.posted_at)} />
          <Row k="Rows" v={posting.rows} />
          <Row k="File" v={<code>{posting.file}</code>} />
        </>
      ) : <Row k="Outage report" v="None on this tick: risk unknown, fail safe" />}
      {archive?.posting?.id !== undefined ? (
        <Row k="Supabase row" v={`ercot_postings.id ${archive.posting.id}${archive.posting.file_name ? ` · ${archive.posting.file_name}` : ""}`} />
      ) : null}
      <Row k="Rule reading" v={provenance.rating ? ruleReading(provenance.rating) : NOT_REPORTED} />
      <Row k="Zone prices" v={orMissing(provenance.zone_prices.label)} />
      {FLOW_ZONES.map((zone) => <Row key={zone} k={`${zone} price`} v={fmtUsd(provenance.zone_prices.zones[zone])} />)}
      {archive?.prices?.length ? (
        <Row k="Price rows" v={archive.prices.map((row) => `${row.settlement_point} ${row.interval_ending}`).join(" · ")} />
      ) : null}
      <Row k="Target" v={`${mw(provenance.target.mw)} · ${provenance.target.label}`} />
      <Row k="Baseline file" v={<code>{provenance.baseline.file}</code>} />
      <Row k="Baseline postings" v={baselineRange(provenance.baseline)} />
      {archive?.overlay ? <Row k="Overlay" v={archive.overlay} /> : null}
    </dl>
  )
}

function EngineDecision({ tick }: { tick: FlowTick }) {
  return (
    <>
      <dl>
        {FLOW_ZONES.map((zone) => (
          <Row key={zone} k={`${zone} floor`}
            v={`${tick.zone_reserve_pct[zone] ?? tick.reserve_pct}% · ${reasonLabel(tick.zone_reasons[zone] ?? tick.policy_reason)}`} />
        ))}
        <Row k="Intent" v={`${tick.intent}${tick.intent_reason ? ` (${tick.intent_reason})` : ""}`} />
        <Row k="Mode" v={MODE_WORDS[tick.mode] ?? tick.mode} />
        <Row k="Reasons" v={tick.reasons.length ? tick.reasons.map(plainReason).join(", ") : "None"} />
        <Row k="Breaches" v={tick.breaches} />
      </dl>
      {tick.brief ? <p className="replay-note">{tick.brief}</p> : null}
    </>
  )
}

export function AboutDataDrawer({ state, onClose }: Props) {
  const ref = useDrawerFocus<HTMLElement>(onClose)
  const provenance = state.provenance
  const scenario = state.scenario
  const overlay = provenance?.archive_rows?.overlay
  return (
    <section ref={ref} tabIndex={-1} role="dialog" className="replay-panel replay-drawer replay-data" aria-label="About this data">
      <div className="replay-ledger-head">
        <div>
          <h2>About this data</h2>
          <p>Archive rows and limits used by the scenario worker.</p>
        </div>
        <button className="replay-pill" type="button" onClick={onClose} aria-label="Close about this data">Close</button>
      </div>
      <section>
        <h3>Scenario</h3>
        {scenario ? (
          <>
            <dl>
              <Row k="Name" v={scenario.name} />
              <Row k="Window" v={orMissing(scenario.window)} />
              <Row k="Label" v={orMissing(scenario.label)} />
              <Row k="Tape" v={scenario.tape ? <code>{scenario.tape}</code> : NOT_REPORTED} />
              <Row k="Baseline" v={scenario.baseline ? <code>{scenario.baseline}</code> : NOT_REPORTED} />
            </dl>
            {scenario.summary ? <p className="replay-note">{scenario.summary}</p> : null}
          </>
        ) : <p className="replay-note">No scenario picked yet.</p>}
      </section>
      <section>
        <h3>Provenance</h3>
        {provenance ? <ProvenanceRows provenance={provenance} /> : <p className="replay-note">No provenance reported yet.</p>}
        <VerifyArchive state={state} />
      </section>
      <section>
        <h3>Engine decision this tick</h3>
        {state.tick ? <EngineDecision tick={state.tick} /> : <p className="replay-note">No tick played yet.</p>}
      </section>
      <section>
        <h3>Zone shares this tick</h3>
        {state.tick ? <ZoneShares zones={state.zones} /> : <p className="replay-note">No tick played yet.</p>}
      </section>
      <section>
        <h3>Alerts</h3>
        {state.alerts.length ? state.alerts.map((alert) => <AlertDetail key={alert.id} alert={alert} />) : <p className="replay-note">No alert sent in this session.</p>}
      </section>
      <section>
        <h3>Overlays (hand-placed)</h3>
        {overlay && provenance ? <p className="replay-note">Tick {provenance.tick}: {overlay}</p> : null}
        {state.grid_down_zones.length
          ? <p className="replay-note">Grid down in {state.grid_down_zones.join(", ")}. Operator overlay, not an archive row.</p> : null}
        {!overlay && !state.grid_down_zones.length ? <p className="replay-note">None this tick.</p> : null}
      </section>
      <section>
        <h3>Starting charge</h3>
        {hasStart(state.start) ? <StartCharge start={state.start} /> : <p className="replay-note">No seeded fleet reported.</p>}
      </section>
      <section>
        <h3>Honest limits</h3>
        <ul>{state.honest_limits.map((line) => <li key={line}>{line}</li>)}</ul>
      </section>
      <section>
        <h3>Session log</h3>
        <SessionLog log={state.log} />
      </section>
    </section>
  )
}

/** The drawer when there is no session to describe, so the button never does nothing. */
export function AboutDataDrawerEmpty({ onClose }: { onClose: () => void }) {
  const ref = useDrawerFocus<HTMLElement>(onClose)
  return (
    <section ref={ref} tabIndex={-1} role="dialog" className="replay-panel replay-drawer replay-data" aria-label="About this data">
      <div className="replay-ledger-head">
        <div>
          <h2>About this data</h2>
          <p>No scenario session is reported, so there is no data to describe yet.</p>
        </div>
        <button className="replay-pill" type="button" onClick={onClose} aria-label="Close about this data">Close</button>
      </div>
    </section>
  )
}
