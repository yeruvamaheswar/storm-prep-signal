import { Fragment } from "react"
import { VerifyArchive } from "../flow/VerifyArchive"
import {
  FLOW_ZONES, type ArchiveRows, type ArchiveRowsDam, type FlowCounty, type FlowTick, type FlowTickDam, type Provenance,
  type SessionState, type StartSummary,
} from "../flow/types"
import { fmtScenarioTime, fmtUsd, reasonLabel } from "../flow/flowMath"
import { AlertDetail } from "./AlertDetail"
import { DataRow as Row } from "./DataRow"
import { NOT_REPORTED, mw, plainReason } from "./format"
import { intentLine } from "./intentCopy"
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
  // HOLD returns an empty allocation before refill (controller.py), so nothing sells and nothing charges.
  HOLD: "Hold: the operator stopped the fleet (no selling, no charging)",
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

/** A zone price, or the drawer's one wording for a missing value. */
function zonePrice(price: number | undefined): string {
  return typeof price === "number" && Number.isFinite(price) ? fmtUsd(price) : NOT_REPORTED
}

/** The tick's day-ahead source: "recorded:ERCOT NP4-190-CD · 2024-07-07,2024-07-08", or the price bands when the
 * scenario has no saved DAM day (dam_label "none"). Not reported by an older worker. */
function damSource(tick: (FlowTick & FlowTickDam) | null): string {
  const label = tick?.dam_label
  if (!label) return NOT_REPORTED
  if (label === "none") return "None: price bands"
  return tick.dam_as_of ? `${label} · ${tick.dam_as_of}` : label
}

/** Each zone's DAM decision (policy.dam_charge `zone_charge_why`) in words. An unknown code shows in words. */
const CHARGE_WHY_WORDS: Record<string, string> = {
  dam_cheap_hour: "charging in its cheapest day-ahead hours",
  before_spike: "charging in its cheapest day-ahead hours before the next sell-band hour",
  rt_dip: "charging on a real-time dip below the day-ahead plan",
  cheaper_hour_later: "waiting for a cheaper day-ahead hour",
  no_payback: "not charging: no later hour pays back",
  full: "not charging: full",
  sell_band: "real-time price is in the sell band",
}

function chargeWhy(code: string): string {
  return CHARGE_WHY_WORDS[code] ?? code.replace(/_/g, " ")
}

function ProvenanceRows({ provenance, tick }: { provenance: Provenance; tick: (FlowTick & FlowTickDam) | null }) {
  const posting = provenance.posting
  const archive: (ArchiveRows & ArchiveRowsDam) | null = provenance.archive_rows
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
      {FLOW_ZONES.map((zone) => <Row key={zone} k={`${zone} price`} v={zonePrice(provenance.zone_prices.zones[zone])} />)}
      {archive?.prices?.length ? (
        <Row k="Price rows" v={archive.prices.map((row) => `${row.settlement_point} ${row.interval_ending}`).join(" · ")} />
      ) : null}
      <Row k="Day-ahead (DAM)" v={damSource(tick)} />
      {archive?.dam?.length ? (
        <Row k="DAM files" v={archive.dam.map((row) => (
          <Fragment key={row.file}>{`${row.report} ${row.delivery_date} · `}<code>{row.file}</code><br /></Fragment>
        ))} />
      ) : null}
      <Row k="Target" v={`${mw(provenance.target.mw)} · ${provenance.target.label}`} />
      <Row k="Baseline file" v={<code>{provenance.baseline.file}</code>} />
      <Row k="Baseline postings" v={baselineRange(provenance.baseline)} />
      {archive?.overlay ? <Row k="Overlay" v={archive.overlay} /> : null}
    </dl>
  )
}

type CountyFloor = { fips: string; label: string; pct: number }

/** The tick's county floors in one zone, in roster order. */
function zoneCountyFloors(zone: string, tick: FlowTick, counties: FlowCounty[]): CountyFloor[] {
  const floors = tick.county_reserve_pct ?? {}
  return counties
    .filter((county) => county.zone === zone && typeof floors[county.fips] === "number")
    .map((county) => ({ fips: county.fips, label: `${county.name} (${county.fips})`, pct: floors[county.fips] }))
}

/** County floors for FIPS codes the roster does not place in a zone (an older or partial roster), by code. */
function unplacedCountyFloors(tick: FlowTick, counties: FlowCounty[]): CountyFloor[] {
  const placed = new Set(counties.map((county) => county.fips))
  return Object.entries(tick.county_reserve_pct ?? {})
    .filter(([fips]) => !placed.has(fips))
    .map(([fips, pct]) => ({ fips, label: `County ${fips}`, pct }))
}

/** "Charge, sold toward the call, then charged": the engine's acted intent in the ledger's words (intentCopy). */
function fleetDid(tick: FlowTick): string {
  return intentLine(tick.intent, tick.intent_reason)?.replace(/^Fleet did: /, "") ?? NOT_REPORTED
}

function EngineDecision({ tick, counties }: { tick: FlowTick & FlowTickDam; counties: FlowCounty[] }) {
  const reasons = tick.county_reasons ?? {}
  const whys = tick.zone_charge_why ?? {}
  const countyRow = (county: CountyFloor) => (
    <Row key={county.fips} sub k={county.label} v={`${county.pct}% · ${reasonLabel(reasons[county.fips])}`} />
  )
  return (
    <>
      <dl>
        {FLOW_ZONES.map((zone) => (
          <Fragment key={zone}>
            <Row k={`${zone} floor`}
              v={`${tick.zone_reserve_pct[zone] ?? tick.reserve_pct}% · ${reasonLabel(tick.zone_reasons[zone] ?? tick.policy_reason)}`} />
            {zoneCountyFloors(zone, tick, counties).map(countyRow)}
          </Fragment>
        ))}
        {unplacedCountyFloors(tick, counties).map(countyRow)}
        {FLOW_ZONES.filter((zone) => whys[zone]).map((zone) => (
          <Row key={`${zone}-charge`} k={`${zone} charge`} v={chargeWhy(whys[zone] ?? "")} />
        ))}
        <Row k="Fleet did" v={fleetDid(tick)} />
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
        {provenance ? <ProvenanceRows provenance={provenance} tick={state.tick} /> : <p className="replay-note">No provenance reported yet.</p>}
        <VerifyArchive state={state} />
      </section>
      <section>
        <h3>Engine decision this tick</h3>
        {state.tick ? <EngineDecision tick={state.tick} counties={state.counties ?? []} /> :<p className="replay-note">No tick played yet.</p>}
      </section>
      <section>
        <h3>Zone shares this tick</h3>
        {state.tick ? <ZoneShares zones={state.zones} /> : <p className="replay-note">No tick played yet.</p>}
      </section>
      <section>
        <h3>Alerts</h3>
        {state.alerts.length ? state.alerts.map((alert) => <AlertDetail key={alert.id} alert={alert} tick={state.tick} />) : <p className="replay-note">No alert sent in this session.</p>}
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
