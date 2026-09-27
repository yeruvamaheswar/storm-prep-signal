import { useState } from "react"
import type { FlowTick, FlowZoneRow } from "../flow/types"
import { FeedPanel } from "../replay/FeedPanel"
import { HomePanel } from "../replay/HomePanel"
import { MapStage } from "../replay/MapStage"
import { PromisePanel } from "../replay/PromisePanel"
import type { Lens } from "../replay/ScenarioRail"
import { ZoneBoard } from "../replay/ZoneBoard"
import { ZonePanel } from "../replay/ZonePanel"
import { fmtClock, HOLD_T } from "../replay/tickClock"
import { zoneWeather } from "../replay/weatherModel"
import { TopBar } from "../shell/TopBar"
import { LiveInputs } from "./LiveInputs"
import { LiveLens } from "./LiveLens"
import { LivePlaybackBar } from "./LivePlaybackBar"
import {
  livePill, liveStatus, liveTick, liveZones, ordersForTick, placeHomes, replayDone, replayT, tickTiming,
  type HomesState, type LiveStatus, type OrdersState, type RunSettings, type SnapshotState,
} from "./liveModel"
import "./live.css"

export type LivePageProps = {
  snapshot: SnapshotState
  /** GET /v1/runs/latest `settings`: tick length, base floor, fleet size. */
  settings: RunSettings
  orders: OrdersState
  homes: HomesState
  /** The demo fleet's size (X-Fleet-Size, else rollups `n`); null when neither says. */
  demoFleet: number | null
  nowMs: number
  /** When "Replay this tick" was pressed; null shows the tick's final state. */
  replayStartMs: number | null
  selectedZone: string | null
  selectedHome: string | null
  backHref?: string
  onZone: (zone: string) => void
  onBack: () => void
  onHome: (homeId: string) => void
  onCloseHome: () => void
  onReplay: () => void
}

const CRUMB = "Live. Click a zone to zoom in."

function Notice({ status }: { status: Exclude<LiveStatus, { kind: "live" }> }) {
  return (
    <div className={`replay-panel replay-worker-empty live-notice is-${status.kind}`} role="status">
      {status.kind === "loading" ? <p>Reading the ERCOT snapshot.</p> : null}
      {status.kind === "error" ? <p>The ERCOT snapshot is unavailable: {status.brief.replace(/\.$/, "")}.</p> : null}
      {status.kind === "not_live" ? <p><b>Not live.</b> {status.reason}</p> : null}
    </div>
  )
}

function homesNote(homes: HomesState): string | null {
  if (homes.kind === "loading") return null
  if (homes.kind === "error") return `Could not read the homes: ${homes.brief.replace(/\.$/, "")}.`
  return homes.note
}

/** Live: Replay's map, zone board and panels, fed by the live engine's newest tick instead of a scenario. */
export function LivePage({
  snapshot, settings, orders, homes, demoFleet, nowMs, replayStartMs, selectedZone, selectedHome, backHref,
  onZone, onBack, onHome, onCloseHome, onReplay,
}: LivePageProps) {
  const [lens, setLens] = useState<Lens>("send")
  const body = snapshot.kind === "ready" ? snapshot.value : null
  const status = liveStatus(snapshot, settings, demoFleet, nowMs)
  const live = status.kind === "live"
  const pill = livePill(status, body, nowMs)

  // Nothing from the tick reaches the screen unless it is live: no stale numbers shown as current.
  const shown = live ? body : null
  const tickOrders = live ? ordersForTick(orders, shown) : null
  const placed = live && homes.kind === "ready" ? placeHomes(homes.homes, shown) : []
  // Partial by design: every Replay view reads these fields optionally and shows "Not reported" when one is missing.
  const tick = shown ? (liveTick(shown) as FlowTick) : null
  const zones = (shown ? liveZones(shown) : {}) as Partial<Record<string, FlowZoneRow>>
  const replaying = replayStartMs !== null && tickOrders?.canReplay === true
  const tSeconds = replayT(replaying ? replayStartMs : null, nowMs)
  const zoneView = selectedZone || null
  const openHome = zoneView ? selectedHome : null

  const timing = status.kind === "loading" ? "Reading the ERCOT snapshot." : tickTiming(body, settings, nowMs)
  let note: string
  if (status.kind === "loading") note = "Nothing to replay yet."
  else if (status.kind === "error") note = "No snapshot, so there is no tick to replay."
  else if (status.kind === "not_live") note = status.reason
  else if (replaying && replayStartMs !== null && replayDone(replayStartMs, nowMs)) note = `Replayed. Holding at ${fmtClock(HOLD_T)}, when books close.`
  else if (replaying) note = `Replaying this tick's orders: ${fmtClock(tSeconds)} of ${fmtClock(HOLD_T)}.`
  else note = tickOrders?.note ?? ""

  return (
    <div className="rg-shell replay-shell live-shell">
      <TopBar
        current="live"
        rightSlot={(
          <span className={`rg-pill live-pill${pill.live ? " is-live" : ""}`}>
            {pill.live ? (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" /></svg>
            ) : null}
            {pill.text}
          </span>
        )}
      />
      <main className={`replay-scene live-scene${zoneView && openHome ? " has-home" : ""}`}>
        {zoneView ? (
          <ZoneBoard
            zone={zoneView}
            homes={placed}
            orders={tickOrders?.orders}
            tSeconds={tSeconds}
            lens={lens}
            tickMinutes={settings.tickMinutes}
            openHome={openHome}
            onHome={onHome}
            onBack={onBack}
            backHref={backHref}
            weather={zoneWeather(zoneView, tick, zones[zoneView], settings.baseFloorPct)}
          />
        ) : (
          <MapStage
            zones={zones}
            homes={placed}
            orders={tickOrders?.orders}
            tick={tick}
            baseFloorPct={settings.baseFloorPct}
            tSeconds={tSeconds}
            lens={lens}
            notice={null}
            onZone={onZone}
            crumbHint={CRUMB}
          />
        )}
        {status.kind !== "live" ? <Notice status={status} /> : null}
        <div className="replay-left">
          <LiveInputs status={status} snapshot={shown} fleetSize={demoFleet} homesNote={live ? homesNote(homes) : null} />
          <LiveLens lens={lens} onLens={setLens} />
        </div>
        {live && zoneView && openHome ? (
          <HomePanel
            key={openHome}
            homeId={openHome}
            home={placed.find((home) => home.id === openHome) ?? null}
            orders={tickOrders?.orders}
            tSeconds={tSeconds}
            tickMinutes={settings.tickMinutes}
            mode={tick?.mode}
            onClose={onCloseHome}
          />
        ) : live ? (
          <div className="replay-right">
            {zoneView ? (
              <ZonePanel zone={zoneView} homes={placed} orders={tickOrders?.orders} tick={tick} tSeconds={tSeconds} />
            ) : (
              <>
                <PromisePanel tick={tick} hideActions onOpenLedger={() => {}} onOpenData={() => {}} />
                <FeedPanel orders={tickOrders?.orders} homes={placed} tick={tick} tSeconds={tSeconds} />
              </>
            )}
          </div>
        ) : null}
        <div className="replay-bottom">
          <LivePlaybackBar timing={timing} note={note} canReplay={tickOrders?.canReplay === true} onReplay={onReplay} />
        </div>
      </main>
    </div>
  )
}
