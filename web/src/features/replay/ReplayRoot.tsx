import { useEffect, useMemo, useState } from "react"
import { apiBaseUrl } from "../../api/health"
import { TopBar } from "../shell/TopBar"
import { readUrlState, subscribeUrlState, writeUrlState, zoomToZone } from "../shell/urlState"
import { fetchScenarios, fetchState, sendRequest, type FlowRequest } from "../flow/api"
import { isWorkerDown, type ScenarioList, type StateReply } from "../flow/types"
import { ReplayPage } from "./ReplayPage"
import "./replay.css"

function safeUrlState() {
  return typeof window === "undefined" ? { scenario: null, zone: null, home: null, tick: null } : readUrlState()
}

export function ReplayRoot() {
  const base = useMemo(() => apiBaseUrl(), [])
  const [scenarios, setScenarios] = useState<ScenarioList | null>(null)
  const [state, setState] = useState<StateReply | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [tickArrivedAtMs, setTickArrivedAtMs] = useState(() => Date.now())
  const [lastTick, setLastTick] = useState<number | null>(null)
  const [url, setUrl] = useState(safeUrlState)

  useEffect(() => subscribeUrlState(setUrl), [])

  useEffect(() => {
    let cancelled = false
    fetchScenarios(fetch, base).then((next) => { if (!cancelled) setScenarios(next) }).catch(() => { if (!cancelled) setScenarios({ scenarios: [], speeds: [15, 60, 300], default_speed: 60 }) })
    return () => { cancelled = true }
  }, [base])

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const next = await fetchState(fetch, base)
        if (cancelled) return
        setState(next)
        if (!isWorkerDown(next) && next.tick_index !== lastTick) {
          setLastTick(next.tick_index)
          setTickArrivedAtMs(Date.now())
        }
      } catch {
        if (!cancelled) setState({ status: "worker_not_running", brief: "scenario state unavailable" })
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [base, lastTick])

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])

  function post(request: FlowRequest) {
    void sendRequest(fetch, base, request).catch(() => undefined)
  }

  const rightSlot = state && !isWorkerDown(state) ? (
    <>
      <span>Scenario</span>
      <span className="rg-pill">{state.scenario?.name ?? "No scenario loaded"}</span>
      <span>Tick {state.tick_index} of {state.tick_count}</span>
    </>
  ) : <span className="rg-pill">No scenario loaded</span>

  return (
    <div className="rg-shell replay-shell">
      <TopBar current="replay" rightSlot={rightSlot} />
      <ReplayPage
        scenarios={scenarios}
        state={state}
        nowMs={nowMs}
        tickArrivedAtMs={tickArrivedAtMs}
        selectedZone={url.zone}
        onZone={(zone) => {
          zoomToZone(zone)
          setUrl(readUrlState())
        }}
        onBack={() => {
          const next = { ...readUrlState(), zone: null, home: null }
          writeUrlState(next, { push: true })
          setUrl(next)
        }}
        onSend={post}
      />
    </div>
  )
}
