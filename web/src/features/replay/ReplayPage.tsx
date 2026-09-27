import { useEffect, useRef, useState } from "react"
import type { FlowRequest } from "../flow/api"
import { isWorkerDown, type ScenarioList, type SessionState, type StartSummary, type StateReply } from "../flow/types"
import { replayTickSeconds } from "./tickClock"
import { AboutDataDrawer, AboutDataDrawerEmpty } from "./AboutDataDrawer"
import { FeedPanel } from "./FeedPanel"
import { HomePanel } from "./HomePanel"
import { LedgerDrawer } from "./LedgerDrawer"
import { MapStage, type StageNotice } from "./MapStage"
import { PlaybackBar } from "./PlaybackBar"
import { PromisePanel } from "./PromisePanel"
import { ScenarioRail, type Lens } from "./ScenarioRail"
import { ZoneBoard } from "./ZoneBoard"
import { ZonePanel } from "./ZonePanel"

type Props = {
  scenarios: ScenarioList | null
  /** True when GET /v1/scenarios failed; nothing is invented in its place. */
  scenariosFailed?: boolean
  state: StateReply | null
  /** True when the API itself could not be reached (distinct from the worker being down). */
  apiDown?: boolean
  apiBase?: string
  /** The last POST's failure, shown next to the playback bar until the next success. */
  postError?: string | null
  nowMs: number
  tickArrivedAtMs?: number
  selectedZone?: string | null
  /** `?home=`: the open home panel inside the zone view. */
  selectedHome?: string | null
  onZone?: (zone: string) => void
  onBack?: () => void
  onHome?: (homeId: string) => void
  onCloseHome?: () => void
  /** Where the "Texas" breadcrumb link points (the URL without zone and home). */
  backHref?: string
  onSend?: (request: FlowRequest) => void
}

type Drawer = "ledger" | "data" | null

function noopSend(_request: FlowRequest): void {
  // Tests render the page without an API.
}

function sessionOrNull(state: StateReply | null): SessionState | null {
  return state && !isWorkerDown(state) ? state : null
}

function baseFloor(session: SessionState | null): number | undefined {
  const value = (session?.start as Partial<StartSummary> | undefined)?.base_floor_pct
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** The tick for the promise panel. `unconfirmed_mw` lives on history points, so it is merged in only when
 * the last history point is this same tick; a stale point's value is never shown against a different tick. */
function promiseTick(session: SessionState | null) {
  if (!session?.tick) return null
  const last = session.history.at(-1)
  return last && last.tick === session.tick.tick ? { ...session.tick, unconfirmed_mw: last.unconfirmed_mw } : { ...session.tick }
}

export function ReplayPage({
  scenarios, scenariosFailed = false, state, apiDown = false, apiBase = "", postError = null, nowMs, tickArrivedAtMs,
  selectedZone, selectedHome = null, onZone, onBack, onHome, onCloseHome, backHref, onSend = noopSend,
}: Props) {
  const [lens, setLens] = useState<Lens>("send")
  const [drawer, setDrawer] = useState<Drawer>(null)
  const opener = useRef<HTMLElement | null>(null)
  const previousDrawer = useRef<Drawer>(null)
  const session = sessionOrNull(state)
  const zoneView = selectedZone || null
  const openHome = zoneView ? selectedHome : null
  const notice: StageNotice = apiDown ? "api_down" : state && isWorkerDown(state) ? "worker_down" : null
  const tSeconds = session ? replayTickSeconds({
    playing: session.status === "playing",
    nowMs,
    tickArrivedAtMs: tickArrivedAtMs ?? nowMs,
    stepSeconds: session.step_seconds,
    scrubberT: 120,
  }) : 120

  // Return focus to the button that opened the drawer once every drawer is closed.
  useEffect(() => {
    if (previousDrawer.current && !drawer && opener.current?.isConnected) opener.current.focus()
    previousDrawer.current = drawer
  }, [drawer])

  function openDrawer(next: Exclude<Drawer, null>, from: HTMLElement | null) {
    opener.current = from
    setDrawer(next)
  }

  return (
    <main className={`replay-scene${zoneView && openHome ? " has-home" : ""}`}>
      {zoneView ? (
        <ZoneBoard
          zone={zoneView}
          homes={session?.homes ?? []}
          orders={session?.orders}
          tSeconds={tSeconds}
          lens={lens}
          tickMinutes={session?.tick_minutes}
          openHome={openHome}
          onHome={onHome ?? (() => {})}
          onBack={onBack ?? (() => {})}
          backHref={backHref}
        />
      ) : (
        <MapStage
          zones={session?.zones ?? {}}
          homes={session?.homes ?? []}
          orders={session?.orders}
          tick={session?.tick ?? null}
          baseFloorPct={baseFloor(session)}
          tSeconds={tSeconds}
          lens={lens}
          notice={notice}
          apiBase={apiBase}
          onZone={onZone ?? (() => {})}
        />
      )}
      {zoneView && notice ? (
        <div className={`replay-panel replay-worker-empty is-${notice}`} role="status">
          <p>{notice === "api_down" ? "Cannot reach the ReserveGate API, so this zone has no homes to show." : "The scenario worker is not running, so this zone has no homes to show."}</p>
        </div>
      ) : null}
      <div className="replay-left">
        <ScenarioRail scenarios={scenarios} scenariosFailed={scenariosFailed} state={session} lens={lens} onLens={setLens} onSend={onSend} />
      </div>
      {zoneView && openHome ? (
        <HomePanel
          key={openHome}
          homeId={openHome}
          home={session?.homes.find((home) => home.id === openHome) ?? null}
          orders={session?.orders}
          tSeconds={tSeconds}
          tickMinutes={session?.tick_minutes}
          onClose={onCloseHome ?? (() => {})}
        />
      ) : (
        <div className="replay-right">
          {zoneView ? (
            <ZonePanel zone={zoneView} homes={session?.homes ?? []} orders={session?.orders} tick={session?.tick ?? null} tSeconds={tSeconds} />
          ) : (
            <>
              <PromisePanel tick={promiseTick(session)}
                onOpenLedger={(from) => openDrawer("ledger", from)} onOpenData={(from) => openDrawer("data", from)} />
              <FeedPanel orders={session?.orders} homes={session?.homes ?? []} tick={session?.tick ?? null} tSeconds={tSeconds} />
            </>
          )}
        </div>
      )}
      {drawer === "ledger" ? (
        <LedgerDrawer title={`Ledger, ${session?.scenario?.name ?? "scenario"}`} history={session?.history ?? []} onClose={() => setDrawer(null)} />
      ) : null}
      {drawer === "data" ? (
        session ? <AboutDataDrawer state={session} onClose={() => setDrawer(null)} /> : (
          <AboutDataDrawerEmpty onClose={() => setDrawer(null)} />
        )
      ) : null}
      <div className="replay-bottom">
        {postError ? <p className="replay-post-error" role="alert">{postError}</p> : null}
        <PlaybackBar state={session} tSeconds={tSeconds} speedsAvailable={!scenariosFailed} onSend={onSend} />
      </div>
    </main>
  )
}
