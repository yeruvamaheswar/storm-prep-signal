import type { FlowHome, FlowTick, OrderTimelineEntry } from "../flow/types"
import { NOT_REPORTED, count } from "./format"
import { zoneActivity } from "./mapModel"
import { feedLines } from "./narrate"
import { OPERATOR_HOLD_TEXT, isOperatorHold } from "./reasonCodes"
import { zoneHomes, zoneSummary } from "./zoneModel"

type Props = {
  zone: string
  homes: FlowHome[]
  orders?: Record<string, OrderTimelineEntry[]>
  tick: FlowTick | null
  tSeconds: number
}

function kwText(value: number | typeof NOT_REPORTED | undefined): string {
  return typeof value === "number" ? `${value.toFixed(1)} kW` : NOT_REPORTED
}

function homesText(n: number | null): string {
  return n === null ? NOT_REPORTED : `${n} ${n === 1 ? "home" : "homes"}`
}

/** The zone's right panel: this tick's asks, confirmations and open kW at the playhead, and the zone's feed. */
export function ZonePanel({ zone, homes, orders, tick, tSeconds }: Props) {
  const activity = orders ? zoneActivity(zone, homes, orders, tSeconds) : null
  const summary = zoneSummary(zone, homes, orders, tSeconds, activity?.asked ?? null)
  const ids = new Set(zoneHomes(homes, zone).map((home) => home.id))
  const zoneOrders = Object.fromEntries(Object.entries(orders ?? {}).filter(([id]) => ids.has(id)))
  // The tick's breach count is fleet-wide. The zone feed's closing line may say "0" only when the whole fleet had 0.
  const breaches = tick?.breaches === 0 ? 0 : undefined
  const lines = feedLines(zoneOrders, tSeconds, {}, { breaches })
  const breachText = count(tick?.breaches)

  return (
    <section className="replay-panel zone-panel" aria-label={`${zone} this tick`}>
      <p className="replay-label">{zone} this tick, {homesText(summary.homes)}</p>
      <div className="zone-row is-first">
        <span>Asked of {homesText(summary.sellHomes)}</span>
        <b>{kwText(summary.sellKw)}</b>
      </div>
      {summary.chargeHomes ? (
        <div className="zone-row">
          <span className="is-charge">Charging, {homesText(summary.chargeHomes)}</span>
          <b className="is-charge">{kwText(summary.chargeKw)}</b>
        </div>
      ) : null}
      <div className="zone-row">
        <span className="is-confirmed">Confirmed</span>
        <b className="is-confirmed">{activity ? kwText(activity.soldKw) : NOT_REPORTED}</b>
      </div>
      <div className="zone-row">
        <span>{summary.openLabel}</span>
        <b className="is-muted">{kwText(summary.openKw)}</b>
      </div>
      {isOperatorHold(tick) ? <p className="replay-note">{OPERATOR_HOLD_TEXT}</p> : null}
      <div className="zone-row">
        <span>Not asked, at their floor</span>
        <b>{homesText(summary.notAskedAtFloor)}</b>
      </div>
      {summary.notAskedReserved ? (
        <div className="zone-row">
          <span>Not asked, kept for backup (floor raised)</span>
          <b>{homesText(summary.notAskedReserved)}</b>
        </div>
      ) : null}
      {summary.notAskedUnderFloor ? (
        <div className="zone-row">
          <span>Not asked, under their floor</span>
          <b>{homesText(summary.notAskedUnderFloor)}</b>
        </div>
      ) : null}
      {summary.notAskedNoReading ? (
        <div className="zone-row">
          <span>Not asked, no fresh reading</span>
          <b>{homesText(summary.notAskedNoReading)}</b>
        </div>
      ) : null}
      {summary.notAskedOther ? (
        <div className="zone-row">
          <span>Not asked, other reasons</span>
          <b>{homesText(summary.notAskedOther)}</b>
        </div>
      ) : null}
      <div className="replay-breaches zone-breaches">
        <span>Backup breaches<small>Whole fleet, this tick</small></span>
        <b className={breachText === NOT_REPORTED ? "is-missing" : undefined}>{breachText}</b>
      </div>
      <p className="replay-label zone-feed-label">What just happened</p>
      <div className="zone-feed">
        {lines.length ? lines.slice(0, 7).map((line, index) => (
          <div key={`${line.t}-${index}-${line.x}`} className="replay-feed-line">
            <span className="mark" style={{ background: line.c }} />
            <span className="time">{line.t}</span>
            <span>{line.x}</span>
          </div>
        )) : <p className="replay-empty-small">No order events in {zone} yet.</p>}
      </div>
      <p className="replay-note">Click any house to follow its order.</p>
    </section>
  )
}
