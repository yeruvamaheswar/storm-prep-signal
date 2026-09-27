import type { FlowHome, OrderTimelineEntry } from "../flow/types"
import { HouseArt } from "./HouseArt"
import { splitOrders, stateColor } from "./orderState"
import { useDrawerFocus } from "./useDrawer"
import {
  askedText, countedText, homeFacts, journeySteps, lotLook, lotUnit, notAskedReason, reassignedFrom, type JourneyStep,
} from "./zoneModel"

type Props = {
  homeId: string
  /** Null when the session does not report this home. */
  home: FlowHome | null
  orders?: Record<string, OrderTimelineEntry[]>
  tSeconds: number
  tickMinutes?: number
  onClose: () => void
}

function Steps({ steps }: { steps: JourneyStep[] }) {
  return (
    <>
      {steps.map((step, index) => (
        <div key={`${step.at}-${index}`} className={`zone-step${step.later ? " later" : ""}`}>
          <span className="tm">{step.t}</span>
          <span>{step.x}</span>
        </div>
      ))}
    </>
  )
}

/** One home's order journey, opened from its lot (`?home=`). Escape or Close shuts it. */
export function HomePanel({ homeId, home, orders, tSeconds, tickMinutes, onClose }: Props) {
  const ref = useDrawerFocus<HTMLElement>(onClose)
  const timeline = orders?.[homeId]
  const unit = lotUnit(timeline)
  const { r } = splitOrders(timeline)
  const takenOver = unit?.key === "own" && r.length ? r : null
  const look = home ? lotLook(home, timeline, tSeconds, false) : null
  const facts = homeFacts(home ?? {})
  const counted = unit ? countedText(unit.timeline, tSeconds) : null
  const from = takenOver || unit?.key === "r" ? reassignedFrom(orders, homeId) : null
  const chip = look ? (look.tookOver ? `${look.label}. Also took over ${from ?? "another home"}'s order` : look.label) : "Not reported in this session"
  const dot = look?.state ? (look.charging && look.state.s !== "lost" && look.state.s !== "rlost" && look.state.s !== "nc" ? "var(--rg-charging)" : stateColor(look.state)) : "var(--rg-not-counted)"

  return (
    <section className="replay-panel zone-home" aria-label="Home detail" ref={ref} tabIndex={-1}>
      <div className="zone-home-head">
        <div>
          <h2>{homeId}</h2>
          <p>
            {home ? `${home.zone} zone. ` : ""}
            {facts.floor === "Not reported" ? "Backup floor not reported." : `Backup floor ${facts.floor} this tick.`}
          </p>
        </div>
        <button type="button" className="replay-pill" onClick={onClose}>Close</button>
      </div>
      <div className="zone-home-art">
        <HouseArt batt={look?.batt ?? "#E9EAE6"} cable={look?.cable ?? "rgba(0,0,0,0)"} />
        <div className="zone-chip">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4.5" style={{ fill: dot }} /></svg>
          {chip}
        </div>
      </div>
      <div className="zone-tiles">
        <div className="zone-tile">
          <p className="replay-label">Asked</p>
          <p className={unit && askedText(unit.timeline).startsWith("Charging") ? "v is-charge" : "v"}>{unit ? askedText(unit.timeline) : "Not asked"}</p>
        </div>
        <div className="zone-tile">
          <p className="replay-label">Counted as sold</p>
          <p className={counted?.confirmed ? "v is-confirmed" : "v is-muted"}>{counted ? counted.text : "Not asked"}</p>
        </div>
      </div>
      <div className="zone-tiles">
        <div className="zone-tile">
          <p className="replay-label">Charge this tick</p>
          <p className="v small">{facts.chargeBefore} → {facts.chargeAfter}</p>
        </div>
        <div className="zone-tile">
          <p className="replay-label">Backup floor</p>
          <p className="v small">{facts.floor}</p>
        </div>
      </div>
      <p className="replay-label zone-journey-label">This order's journey</p>
      <div className="zone-journey">
        {unit ? (
          <>
            {unit.key === "r" ? <p className="zone-sub">Taken over from {from ?? "another home"}</p> : null}
            <Steps steps={journeySteps(unit.timeline, tSeconds, tickMinutes)} />
            {takenOver ? (
              <>
                <p className="zone-sub">Taken over from {from ?? "another home"}</p>
                <Steps steps={journeySteps(takenOver, tSeconds, tickMinutes)} />
              </>
            ) : null}
          </>
        ) : home ? (
          <div className="zone-step">
            <span className="tm">0:00</span>
            <span>{["Not asked this tick.", notAskedReason(home)].filter(Boolean).join(" ")}</span>
          </div>
        ) : (
          <p className="replay-empty-small">The session reports no home with this id.</p>
        )}
      </div>
    </section>
  )
}
