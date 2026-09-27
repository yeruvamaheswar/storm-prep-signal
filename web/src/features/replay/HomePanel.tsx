import { lazy, Suspense, useState } from "react"
import type { ActiveAlert, FlowHome, OrderTimelineEntry } from "../flow/types"
import { houseModel } from "./house3dModel"
import { HouseArt } from "./HouseArt"
import { splitOrders } from "./orderState"
import { useDrawerFocus } from "./useDrawer"
import { WebGLBoundary } from "./WebGLBoundary"
import { hasWebGL } from "./webgl"
import {
  BATT_IDLE, TRANSPARENT, askedText, orderColor, countedText, homeFacts, homeFloorWords, journeySteps, lotLook, lotUnit, notAskedReason, reassignedFrom, refillLine, type JourneyStep,
} from "./zoneModel"

/** three.js lives in this chunk only; the flat HouseArt shows while it loads and when WebGL is missing. */
const House3D = lazy(() => import("./House3D"))

type Props = {
  homeId: string
  /** Null when the session does not report this home. */
  home: FlowHome | null
  orders?: Record<string, OrderTimelineEntry[]>
  tSeconds: number
  tickMinutes?: number
  /** The tick's mode (`tick.mode`). HOLD means nothing was sent this tick. */
  mode?: string | null
  /** `state.alerts`: names the alert event for a county it names. Missing: the reason label only. */
  alerts?: ActiveAlert[]
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
export function HomePanel({ homeId, home, orders, tSeconds, tickMinutes, mode, alerts, onClose }: Props) {
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
  const dot = look?.state ? orderColor(look.state, look.charging) : "var(--rg-not-counted)"
  const asked = unit ? askedText(unit.timeline, tSeconds) : "Not asked"
  const refill = home ? refillLine(home) : null
  const [webgl] = useState(hasWebGL)
  const flat = <HouseArt batt={look?.batt ?? BATT_IDLE} cable={look?.cable ?? TRANSPARENT} />

  return (
    <section className="replay-panel zone-home" aria-label="Home detail" ref={ref} tabIndex={-1}>
      <div className="zone-home-head">
        <div>
          {/* #47: the display name (e.g. Houston-FortBend-005) and county; the id stays for search and ?home=. */}
          <h2>{home?.name || homeId}</h2>
          <p>
            {home ? `${home.zone} zone${home.county_name ? `, ${home.county_name} County` : ""}. ` : ""}
            {facts.floor === "Not reported" ? "Backup floor not reported." : `Backup floor ${facts.floor} this tick.`}
            {/* The county floor's reason, e.g. "Named in the Tropical Storm Warning (storm reserve)" or
                "County not named by the alert (base floor)". */}
            {home?.floor_reason ? ` ${homeFloorWords(home, alerts)}.` : ""}
          </p>
          {refill ? <p className="zone-refill">{refill}.</p> : null}
        </div>
        <button type="button" className="replay-pill" onClick={onClose}>Close</button>
      </div>
      <div className="zone-home-art">
        {webgl ? (
          <WebGLBoundary fallback={flat}>
            <Suspense fallback={flat}>
              <House3D model={houseModel(home, look)} />
            </Suspense>
          </WebGLBoundary>
        ) : flat}
        <div className="zone-chip">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4.5" style={{ fill: dot }} /></svg>
          {chip}
        </div>
      </div>
      <div className="zone-tiles">
        <div className="zone-tile">
          <p className="replay-label">Asked</p>
          <p className={asked.startsWith("Charging") ? "v is-charge" : "v"}>{asked}</p>
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
            <span>{["Not asked this tick.", notAskedReason(home, mode, alerts)].filter(Boolean).join(" ")}</span>
          </div>
        ) : (
          <p className="replay-empty-small">The session reports no home with this id.</p>
        )}
      </div>
    </section>
  )
}
