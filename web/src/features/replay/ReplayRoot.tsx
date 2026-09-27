import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { apiBaseUrl } from "../../api/health"
import { TopBar } from "../shell/TopBar"
import { hrefForUrlState, readUrlState, subscribeUrlState, writeUrlState, zoomToHome, zoomToZone } from "../shell/urlState"
import { fetchScenarios, fetchState, sendRequest, type FlowRequest } from "../flow/api"
import { isWorkerDown, type ScenarioList, type SessionState, type StateReply } from "../flow/types"
import {
  advanceDayHead, canSeek, dayPlayheadMs, dayStops, dayWindow, emptyArrivals, freshReply, initialDayHead,
  observedSecondsPerTick, ordersViewSpeed, replyUpdatedMs, runKey, seekClock, seekLanding, settleSeek, trackArrivals,
  viewPlaySpeed, type PollMark, type SeekPending,
} from "./dayModel"
import { canStep, type ReplayView } from "./PlaybackBar"
import { ReplayPage } from "./ReplayPage"
import { SCENARIO_POLL_MS_PHONE, clockMs, isPhonePortrait } from "./phoneMedia"
import { SPEED_STOPS, advancePlayhead, initialPlayhead, playheadSeconds } from "./tickClock"
import { rememberSpeed, useReplayKeys, type SentSpeed } from "./useReplayKeys"
import "./replay.css"

function safeUrlState() {
  return typeof window === "undefined" ? { scenario: null, zone: null, home: null, tick: null } : readUrlState()
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "the API did not accept the request"
}

/** Day view polls faster, so a tick at about 1 min per day (0.21 s) is seen close to when it lands. */
const POLL_MS: Record<ReplayView, number> = { day: 250, orders: 500 }

/** The real length of one tick, for the sun's fade between ticks (`--replay-step-ms`, replay.css). */
function stepMs(session: SessionState | null): string {
  const ms = session && session.status === "playing" ? session.step_seconds * 1000 : 0
  return `${Math.round(Math.min(2000, Math.max(0, Number.isFinite(ms) ? ms : 0)))}ms`
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
  // Task 14: the Day view is the default. Its playhead glides between real ticks' ts; the pace is measured from arrivals.
  const [view, setView] = useState<ReplayView>("day")
  const [dayHead, setDayHead] = useState(initialDayHead)
  const [arrivals, setArrivals] = useState(emptyArrivals)
  // Task 16B: a seek this page sent, until the worker lands on it.
  const [seekPending, setSeekPending] = useState<SeekPending | null>(null)
  const [url, setUrl] = useState(safeUrlState)
  // The last speed sent (slider or keys), so [ and ] nudge from it before the next poll reports it.
  const sentSpeed = useRef<SentSpeed | null>(null)
  // Poll order (fix round 2): each poll is numbered; a reply older than the last one applied is dropped.
  const pollCount = useRef(0)
  const lastApplied = useRef<PollMark | null>(null)

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
      const id = ++pollCount.current
      try {
        const next = await fetchState(fetch, base)
        if (cancelled || !freshReply(lastApplied.current, id, next)) return
        lastApplied.current = { id, updatedMs: replyUpdatedMs(next) ?? lastApplied.current?.updatedMs ?? null }
        setApiDown(false)
        setState(next)
        if (!isWorkerDown(next)) {
          const now = Date.now()
          const playing = next.status === "playing"
          const observed = {
            tickIndex: next.tick_index, playing, stepSeconds: next.step_seconds, nowMs: now,
            finished: next.status === "finished", tickLeft: next.tick_left_s,
          }
          setPlayhead((prev) => advancePlayhead(prev, observed))
          const tsMs = next.tick?.ts ? Date.parse(next.tick.ts) : NaN
          setDayHead((prev) => advanceDayHead(prev, {
            tickIndex: next.tick_index, tsMs: Number.isFinite(tsMs) ? tsMs : null, playing: playing && next.seeking !== true,
            stepSeconds: next.step_seconds, tickMinutes: next.tick_minutes, tickLeft: next.tick_left_s, nowMs: now,
          }))
          // A new run (scenario switch or reset) starts the pace and any pending seek over; the Day bar's window,
          // marks and playhead are read from this state, so they follow it.
          const key = runKey(next)
          setArrivals((prev) => trackArrivals(prev, { key, tickIndex: next.tick_index, playing, speed: next.speed, atMs: now }))
          // `last_seek` present (even null) means this worker answers seeks by seq; absent means an older worker.
          const lastSeekSeq = "last_seek" in next ? (next.last_seek?.seq ?? null) : undefined
          setSeekPending((prev) => settleSeek(prev, { seeking: next.seeking, tickIndex: next.tick_index, key, lastSeekSeq }, now))
        }
      } catch {
        // A failed poll older than a reply already applied says nothing about now.
        if (!cancelled && id > (lastApplied.current?.id ?? 0)) setApiDown(true)
      }
    }
    void poll()
    // Phone: floor at 1 s to cut work; desktop keeps Day at 250 ms / Orders at 500 ms.
    const ms = isPhonePortrait() ? Math.max(POLL_MS[view], SCENARIO_POLL_MS_PHONE) : POLL_MS[view]
    const timer = setInterval(() => void poll(), ms)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [base, view])

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), clockMs())
    return () => clearInterval(timer)
  }, [])

  const live = state && !isWorkerDown(state) && !apiDown ? state : null

  function send(request: FlowRequest, sentAtMs?: number) {
    rememberSpeed(sentSpeed, request, live?.speed ?? null, Date.now())
    sendRequest(fetch, base, request)
      .then((seq) => {
        setPostError(null)
        // The worker answers a seek by this seq in `last_seek`; keep it on the seek it belongs to.
        if (request.kind === "seek") setSeekPending((prev) => (prev && prev.atMs === sentAtMs ? { ...prev, seq } : prev))
      })
      .catch((err: unknown) => {
        setPostError(`Could not send "${request.kind}": ${errorText(err)}.`)
        if (request.kind === "seek") setSeekPending(null)
      })
  }

  function post(request: FlowRequest) {
    // Rajat's coupling: Play or Start in Day view first asks for the day pace when the speed is not a day stop.
    const x = viewPlaySpeed(view, request, live)
    if (x !== null) send({ kind: "speed", body: { x } })
    // A start or reset (a same-seed restart keeps the run key) drops any seek still pending.
    if (request.kind === "start" || request.kind === "reset") setSeekPending(null)
    if (request.kind === "seek") {
      const win = live ? dayWindow(live) : null
      const atMs = Date.now()
      // The label and ghost show the expected landing: the tick, or for a delta the reported tick plus the delta.
      const tick = live ? seekLanding(live, request.body) : "tick" in request.body ? request.body.tick : 0
      setSeekPending({
        tick, label: win && live ? seekClock(win, tick, live.tick_minutes) : null,
        atMs, key: runKey(live), sawSeeking: false, seq: null, fromIndex: live?.tick_index,
      })
      send(request, atMs)
      return
    }
    send(request)
  }

  function changeView(next: ReplayView) {
    setView(next)
    // Watch orders plays one tick's order window; a day pace would flash through it.
    const x = next === "orders" ? ordersViewSpeed(live) : null
    if (x !== null) send({ kind: "speed", body: { x } })
  }

  const seekBusy = seekPending !== null || live?.seeking === true
  useReplayKeys({
    status: live?.status ?? null,
    speed: live?.speed ?? null,
    speeds: scenariosFailed ? null : live?.speeds,
    canStep: canStep(live),
    sent: sentSpeed,
    // [ and ] move within the current view's stops (the DayBar presets' tooltip names them).
    stops: view === "day" ? dayStops(live?.speeds) : SPEED_STOPS,
    tickIndex: live?.tick_index ?? null,
    tickCount: live?.tick_count ?? null,
    tickMinutes: live?.tick_minutes ?? null,
    canSeek: !seekBusy && canSeek(live),
  }, post)
  const playheadT = live ? playheadSeconds(playhead, nowMs) : undefined
  // Phone TopBar is tight: name + tick only (the "Scenario" label is desktop).
  const rightSlot = live ? (
    <>
      <span className="rg-slot-label">Scenario</span>
      <span className="rg-pill rg-pill-scenario">{live.scenario?.name ?? "No scenario loaded"}</span>
      <span className="rg-tick">Tick {live.tick_index} of {live.tick_count}</span>
    </>
  ) : <span className="rg-pill">No scenario loaded</span>

  return (
    <div className="rg-shell replay-shell" style={{ "--replay-step-ms": stepMs(live) } as CSSProperties}>
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
        view={view}
        onView={changeView}
        dayPlayheadMs={live ? dayPlayheadMs(dayHead, nowMs) : null}
        observedStepSeconds={observedSecondsPerTick(arrivals.list)}
        seek={seekBusy ? { busy: true, label: seekPending?.label ?? null, tick: seekPending?.tick ?? null } : null}
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
