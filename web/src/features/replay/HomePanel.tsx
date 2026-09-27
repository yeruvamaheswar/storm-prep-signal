import { lazy, Suspense, useState } from "react"
import { reasonLabel } from "../flow/flowMath"
import type { FlowHome, OrderTimelineEntry } from "../flow/types"
import { homeName, homeNameById } from "./homeName"
import { houseModel } from "./house3dModel"
import { HouseArt } from "./HouseArt"
import { splitOrders } from "./orderState"
import { useDrawerFocus } from "./useDrawer"
import { WebGLBoundary } from "./WebGLBoundary"
import { hasWebGL } from "./webgl"
import {
  BATT_IDLE, TRANSPARENT, askedText, orderColor, countedText, homeFacts, journeySteps, lotLook, lotUnit, notAskedReason, reassignedFrom, refillLine, type JourneyStep,
} from "./zoneModel"

/** three.js lives in this chunk only; the flat HouseArt shows while it loads and when WebGL is missing. */
const House3D = lazy(() => import("./House3D"))

type Props = {
  homeId: string
  /** Null when the session does not report this home. */
  home: FlowHome | null
  /** The session's homes, so a home an order came from or went to is named too (Task 17). Without it, that
   * other home shows its raw id. */
  homes?: FlowHome[]
  orders?: Record<string, OrderTimelineEntry[]>
  tSeconds: number
  tickMinutes?: number
  /** The tick's mode (`tick.mode`). HOLD means nothing was sent this tick. */
  mode?: string | null
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
export function HomePanel({ homeId, home, homes, orders, tSeconds, tickMinutes, mode, onClose }: Props) {
  const nameOf = (id: string) => homeNameById(homes, id)
  const ref = useDrawerFocus<HTMLElement>(onClose)
  const timeline = orders?.[homeId]
  const unit = lotUnit(timeline)
  const { r } = splitOrders(timeline)
  const takenOver = unit?.key === "own" && r.length ? r : null
  const look = home ? lotLook(home, timeline, tSeconds, false) : null
  const facts = homeFacts(home ?? {})
  const counted = unit ? countedText(unit.timeline, tSeconds) : null
  const fromId = takenOver || unit?.key === "r" ? reassignedFrom(orders, homeId) : null
  const from = fromId === null ? null : nameOf(fromId)
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
          {/* #47, Task 17: the one display name (e.g. Houston-FortBend-005); the id stays for search and ?home=. */}
          <h2>{home ? homeName({ ...home, id: homeId }) : homeId}</h2>
          <p>
            {home ? `${home.zone} zone${home.county_name ? `, ${home.county_name} County` : ""}. ` : ""}
            {facts.floor === "Not reported" ? "Backup floor not reported." : `Backup floor ${facts.floor} this tick.`}
            {/* #47: the county floor's reason, e.g. "NWS weather alert" or "County not named by the alert (base floor)". */}
            {home?.floor_reason ? ` ${reasonLabel(home.floor_reason)}.` : ""}
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
            <Steps steps={journeySteps(unit.timeline, tSeconds, tickMinutes, nameOf)} />
            {takenOver ? (
              <>
                <p className="zone-sub">Taken over from {from ?? "another home"}</p>
                <Steps steps={journeySteps(takenOver, tSeconds, tickMinutes, nameOf)} />
              </>
            ) : null}
          </>
        ) : home ? (
          <div className="zone-step">
            <span className="tm">0:00</span>
            <span>{["Not asked this tick.", notAskedReason(home, mode)].filter(Boolean).join(" ")}</span>
          </div>
        ) : (
          <p className="replay-empty-small">The session reports no home with this id.</p>
        )}
      </div>
    </section>
  )
}
