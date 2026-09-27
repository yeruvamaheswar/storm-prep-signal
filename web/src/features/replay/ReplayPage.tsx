import { useState } from "react"
import type { FlowRequest } from "../flow/api"
import { isWorkerDown, type ScenarioList, type SessionState, type StateReply } from "../flow/types"
import { replayTickSeconds } from "./tickClock"
import { AboutDataDrawer } from "./AboutDataDrawer"
import { FeedPanel } from "./FeedPanel"
import { LedgerDrawer } from "./LedgerDrawer"
import { MapStage } from "./MapStage"
import { PlaybackBar } from "./PlaybackBar"
import { PromisePanel } from "./PromisePanel"
import { ScenarioRail, type Lens } from "./ScenarioRail"

type Props = {
  scenarios: ScenarioList | null
  state: StateReply | null
  nowMs: number
  tickArrivedAtMs?: number
  selectedZone?: string | null
  onZone?: (zone: string) => void
  onBack?: () => void
  onSend?: (request: FlowRequest) => void
}

function noopSend(_request: FlowRequest): void {
  // Tests render the page without an API.
}

function sessionOrNull(state: StateReply | null): SessionState | null {
  return state && !isWorkerDown(state) ? state : null
}

/** The tick for the promise panel. `unconfirmed_mw` lives on history points, so it is merged in only when
 * the last history point is this same tick; a stale point's value is never shown against a different tick. */
function promiseTick(session: SessionState | null) {
  if (!session?.tick) return null
  const last = session.history.at(-1)
  return last && last.tick === session.tick.tick ? { ...session.tick, unconfirmed_mw: last.unconfirmed_mw } : { ...session.tick }
}

export function ReplayPage({ scenarios, state, nowMs, tickArrivedAtMs, selectedZone, onZone, onBack, onSend = noopSend }: Props) {
  const [lens, setLens] = useState<Lens>("send")
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [dataOpen, setDataOpen] = useState(false)
  const session = sessionOrNull(state)
  const workerDown = state ? isWorkerDown(state) : false
  const tSeconds = session ? replayTickSeconds({
    playing: session.status === "playing",
    nowMs,
    tickArrivedAtMs: tickArrivedAtMs ?? nowMs,
    stepSeconds: session.step_seconds,
    scrubberT: 120,
  }) : 120

  return (
    <main className="replay-scene">
      <MapStage
        zones={session?.zones ?? {}}
        homes={session?.homes ?? []}
        orders={session?.orders}
        tick={session?.tick ?? null}
        lens={lens}
        workerDown={workerDown}
        onZone={onZone ?? (() => {})}
      />
      {selectedZone ? (
        <section className="replay-panel replay-zone-next" aria-label="Zone view">
          <h1>{selectedZone}</h1>
          <p>Zone view coming next.</p>
          <button className="replay-pill" type="button" onClick={onBack}>Back to Texas</button>
        </section>
      ) : null}
      <ScenarioRail scenarios={scenarios} state={session} lens={lens} onLens={setLens} onSend={onSend} />
      <PromisePanel tick={promiseTick(session)}
        onOpenLedger={() => setLedgerOpen(true)} onOpenData={() => setDataOpen(true)} />
      {ledgerOpen ? (
        <LedgerDrawer title={`Ledger, ${session?.scenario?.name ?? "scenario"}`} history={session?.history ?? []} onClose={() => setLedgerOpen(false)} />
      ) : dataOpen && session ? (
        <AboutDataDrawer state={session} onClose={() => setDataOpen(false)} />
      ) : (
        <FeedPanel orders={session?.orders} homes={session?.homes ?? []} tick={session?.tick ?? null} tSeconds={tSeconds} />
      )}
      <PlaybackBar state={session} tSeconds={tSeconds} onSend={onSend} />
    </main>
  )
}
