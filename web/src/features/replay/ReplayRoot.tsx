import { useEffect, useMemo, useRef, useState } from "react"
import { apiBaseUrl } from "../../api/health"
import { TopBar } from "../shell/TopBar"
import { hrefForUrlState, readUrlState, subscribeUrlState, writeUrlState, zoomToHome, zoomToZone } from "../shell/urlState"
import { fetchScenarios, fetchState, sendRequest, type FlowRequest } from "../flow/api"
import { isWorkerDown, type ScenarioList, type StateReply } from "../flow/types"
import { canStep } from "./PlaybackBar"
import { ReplayPage } from "./ReplayPage"
import { advancePlayhead, initialPlayhead, playheadSeconds } from "./tickClock"
import { rememberSpeed, useReplayKeys, type SentSpeed } from "./useReplayKeys"
import "./replay.css"

function safeUrlState() {
  return typeof window === "undefined" ? { scenario: null, zone: null, home: null, tick: null } : readUrlState()
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "the API did not accept the request"
}

export function ReplayRoot() {
  const base = useMemo(() => apiBaseUrl(), [])
  const [scenarios, setScenarios] = useState<ScenarioList | null>(null)
  const [scenariosFailed, setScenariosFailed] = useState(false)
  const [state, setState] = useState<StateReply | null>(null)
  const [apiDown, setApiDown] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  // Where the playhead sits inside the current tick; re-anchored on each new tick and each speed change.
  const [playhead, setPlayhead] = useState(() => initialPlayhead(Date.now()))
  const [url, setUrl] = useState(safeUrlState)
  // The last speed sent (slider or keys), so [ and ] nudge from it before the next poll reports it.
  const sentSpeed = useRef<SentSpeed | null>(null)

  useEffect(() => subscribeUrlState(setUrl), [])

  useEffect(() => {
    let cancelled = false
    fetchScenarios(fetch, base)
      .then((next) => {
        if (cancelled) return
        setScenarios(next)
        setScenariosFailed(false)
      })
      .catch(() => {
        // No invented catalog or speeds: the rail says so and the speed buttons are disabled.
        if (!cancelled) setScenariosFailed(true)
      })
    return () => { cancelled = true }
  }, [base])

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const next = await fetchState(fetch, base)
        if (cancelled) return
        setApiDown(false)
        setState(next)
        if (!isWorkerDown(next)) {
          const observed = {
            tickIndex: next.tick_index, playing: next.status === "playing", stepSeconds: next.step_seconds, nowMs: Date.now(),
            finished: next.status === "finished", tickLeft: next.tick_left_s,
          }
          setPlayhead((prev) => advancePlayhead(prev, observed))
        }
      } catch {
        if (!cancelled) setApiDown(true)
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [base])

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])

  function post(request: FlowRequest) {
    rememberSpeed(sentSpeed, request, live?.speed ?? null, Date.now())
    sendRequest(fetch, base, request)
      .then(() => setPostError(null))
      .catch((err: unknown) => setPostError(`Could not send "${request.kind}": ${errorText(err)}.`))
  }

  const live = state && !isWorkerDown(state) && !apiDown ? state : null
  useReplayKeys({
    status: live?.status ?? null,
    speed: live?.speed ?? null,
    speeds: scenariosFailed ? null : live?.speeds,
    canStep: canStep(live),
    sent: sentSpeed,
  }, post)
  const playheadT = live ? playheadSeconds(playhead, nowMs) : undefined
  const rightSlot = live ? (
    <>
      <span>Scenario</span>
      <span className="rg-pill">{live.scenario?.name ?? "No scenario loaded"}</span>
      <span>Tick {live.tick_index} of {live.tick_count}</span>
    </>
  ) : <span className="rg-pill">No scenario loaded</span>

  return (
    <div className="rg-shell replay-shell">
      <TopBar current="replay" rightSlot={rightSlot} />
      <ReplayPage
        scenarios={scenarios}
        scenariosFailed={scenariosFailed}
        state={apiDown ? null : state}
        apiDown={apiDown}
        apiBase={base}
        postError={postError}
        nowMs={nowMs}
        playheadT={playheadT}
        selectedZone={url.zone}
        selectedHome={url.home}
        backHref={typeof window === "undefined" ? "/" : hrefForUrlState(window.location.pathname, { ...url, zone: null, home: null })}
        onHome={(home) => {
          zoomToHome(home)
          setUrl(readUrlState())
        }}
        onCloseHome={() => {
          // Replace, not push: Back after Close must not reopen the panel.
          const next = { ...readUrlState(), home: null }
          writeUrlState(next)
          setUrl(next)
        }}
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
