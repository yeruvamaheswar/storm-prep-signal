import { useCallback, useEffect, useState } from "react"
import { apiBaseUrl } from "../../api/health"
import { fetchScenarios, fetchState, sendRequest, type FlowRequest } from "./api"
import { DataPanel } from "./DataPanel"
import { FlowControls } from "./FlowControls"
import { zoneShapes, type ZoneShape } from "./flowMath"
import { GridFlow } from "./GridFlow"
import { HistoryStrip } from "./HistoryStrip"
import { VerifyArchive } from "./VerifyArchive"
import { ZoneBatteries } from "./ZoneBatteries"
import { ZoneContribution } from "./ZoneContribution"
import "./flow.css"
import { isWorkerDown, type ScenarioList, type StateReply } from "./types"

const GEO_URL = "/geo/ercot-load-zones.json"
const POLL_MS = 500

export function FlowApp() {
  const [shapes, setShapes] = useState<ZoneShape[]>([])
  const [scenarios, setScenarios] = useState<ScenarioList | null>(null)
  const [reply, setReply] = useState<StateReply | null>(null)
  const [apiError, setApiError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selectedZone, setSelectedZone] = useState<string | null>(null)

  useEffect(() => {
    document.title = "ReserveGate grid flow"
    fetch(GEO_URL).then((res) => res.json()).then((geo) => setShapes(zoneShapes(geo))).catch(() => setShapes([]))
  }, [])

  useEffect(() => {
    let cancelled = false
    const base = apiBaseUrl()
    async function loadList() {
      try {
        const list = await fetchScenarios(fetch, base)
        if (!cancelled) setScenarios(list)
      } catch {
        if (!cancelled) setTimeout(() => void loadList(), 3000)
      }
    }
    void loadList()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const base = apiBaseUrl()
    async function poll() {
      try {
        const next = await fetchState(fetch, base)
        if (!cancelled) {
          setReply(next)
          setApiError(null)
        }
      } catch (err) {
        if (!cancelled) setApiError(err instanceof Error ? err.message : "unreachable")
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const send = useCallback((request: FlowRequest) => {
    setNotice(`Sent ${request.kind}. The session worker applies it on its next loop.`)
    sendRequest(fetch, apiBaseUrl(), request).catch((err: unknown) => {
      setNotice(`Refused: ${err instanceof Error ? err.message : "unknown error"}`)
    })
  }, [])

  const state = reply && !isWorkerDown(reply) ? reply : null
  const pack = state && "pack" in state.start ? state.start.pack : null

  return (
    <div className="flow-page">
      <header className="flow-mast">
        <h1 className="flow-title">Grid flow</h1>
        <p className="flow-kicker">Engine replay over recorded ERCOT data</p>
        <nav className="flow-nav">
          <a href="/">Wall</a>
          <a href="/fleet">Fleet</a>
        </nav>
      </header>

      {apiError ? <p className="flow-banner is-down">API unreachable ({apiError}). Start it: uvicorn server.app:app</p> : null}
      {reply && isWorkerDown(reply) ? (
        <p className="flow-banner is-down">Session worker not running. {reply.brief}</p>
      ) : null}
      {state?.error ? <p className="flow-banner is-down">Tick failed: {state.error}</p> : null}

      <FlowControls scenarios={scenarios} state={state} onSend={send} />
      {notice ? <p className="flow-notice">{notice}</p> : null}

      <main className="flow-body">
        <div className="flow-stage">
          <GridFlow shapes={shapes} zones={state?.zones ?? {}} tick={state?.tick ?? null}
            chargingMw={state?.charging_mw ?? 0} packKw={pack?.kw ?? 11.4}
            selectedZone={selectedZone} onSelect={setSelectedZone} />
          {state ? <ZoneContribution zones={state.zones} /> : null}
          {state ? <HistoryStrip history={state.history} tickCount={state.tick_count}
            targetLabel={state.tick?.target_label ?? "synthetic"} /> : null}
          {state?.tick ? <p className="flow-brief">{state.tick.brief}</p> : null}
          {selectedZone && state ? (
            <ZoneBatteries zone={selectedZone} row={state.zones[selectedZone]} homes={state.homes}
              counties={state.counties ?? []} stepSeconds={state.step_seconds} pack={pack} onClose={() => setSelectedZone(null)} />
          ) : (
            <p className="flow-muted">Click a zone on the map to see each battery.</p>
          )}
        </div>
        {state ? <DataPanel state={state} verify={<VerifyArchive state={state} />} /> : null}
      </main>
    </div>
  )
}
