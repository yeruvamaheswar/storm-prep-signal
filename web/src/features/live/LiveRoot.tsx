import { useEffect, useMemo, useState } from "react"
import { apiBaseUrl } from "../../api/health"
import { hrefForUrlState, readUrlState, subscribeUrlState, writeUrlState, zoomToHome, zoomToZone } from "../shell/urlState"
import "../replay/replay.css"
import { LivePage } from "./LivePage"
import {
  fleetSizeFrom, homesStateFromReply, ordersFromReply, settingsFromRun, snapshotFromReply,
  type HomesState, type OrdersState, type RunSettings, type SnapshotState,
} from "./liveModel"

/** The wall polls /v1/snapshot every 20 s; Live reads the same body and the tick's files on the same beat. */
const POLL_MS = 20_000
const TIMEOUT_MS = 15_000
const CLOCK_MS = 250
const HOMES_LIMIT = 200
const UNREACHABLE = "cannot reach the ReserveGate API"

type Reply = { status: number; body: unknown; headers: Headers }

async function getJson(url: string): Promise<Reply> {
  const res = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // Keep the bare status when the body is not JSON.
  }
  return { status: res.status, body, headers: res.headers }
}

function safeUrlState() {
  return typeof window === "undefined" ? { scenario: null, zone: null, home: null, tick: null } : readUrlState()
}

export function LiveRoot() {
  const base = useMemo(() => apiBaseUrl(), [])
  const [snapshot, setSnapshot] = useState<SnapshotState>({ kind: "loading" })
  const [settings, setSettings] = useState<RunSettings>({})
  const [orders, setOrders] = useState<OrdersState>({ kind: "loading" })
  const [homes, setHomes] = useState<HomesState>({ kind: "loading" })
  const [demoFleet, setDemoFleet] = useState<number | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [replayStartMs, setReplayStartMs] = useState<number | null>(null)
  const [url, setUrl] = useState(safeUrlState)

  useEffect(() => subscribeUrlState(setUrl), [])

  useEffect(() => {
    let cancelled = false
    async function poll() {
      const [snap, run, tickOrders, rows] = await Promise.allSettled([
        getJson(`${base}/v1/snapshot`),
        getJson(`${base}/v1/runs/latest`),
        getJson(`${base}/v1/live/orders`),
        getJson(`${base}/v1/homes?limit=${HOMES_LIMIT}`),
      ])
      if (cancelled) return
      // A failed read is said plainly; the last good value is never kept on screen as current.
      setSnapshot(snap.status === "fulfilled" ? snapshotFromReply(snap.value.status, snap.value.body) : { kind: "error", brief: UNREACHABLE })
      setSettings(run.status === "fulfilled" && run.value.status === 200 ? settingsFromRun(run.value.body) : {})
      setOrders(tickOrders.status === "fulfilled" ? ordersFromReply(tickOrders.value.status, tickOrders.value.body) : { kind: "error", brief: UNREACHABLE })
      const nextHomes = rows.status === "fulfilled"
        ? homesStateFromReply(rows.value.status, rows.value.body, rows.value.headers)
        : { kind: "error" as const, brief: UNREACHABLE }
      setHomes(nextHomes)
      const headerSize = nextHomes.kind === "ready" ? nextHomes.fleetSize : null
      if (headerSize !== null) {
        setDemoFleet(headerSize)
        return
      }
      try {
        const rollups = await getJson(`${base}/v1/fleet/rollups`)
        if (!cancelled) setDemoFleet(fleetSizeFrom(null, rollups.status === 200 ? rollups.body : null))
      } catch {
        if (!cancelled) setDemoFleet(null)
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [base])

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_MS)
    return () => clearInterval(timer)
  }, [])

  // A new tick's orders end any replay of the previous tick.
  const ordersTs = orders.kind === "ready" ? orders.ts : null
  useEffect(() => setReplayStartMs(null), [ordersTs])

  return (
    <LivePage
      snapshot={snapshot}
      settings={settings}
      orders={orders}
      homes={homes}
      demoFleet={demoFleet}
      nowMs={nowMs}
      replayStartMs={replayStartMs}
      selectedZone={url.zone}
      selectedHome={url.home}
      backHref={typeof window === "undefined" ? "/live" : hrefForUrlState(window.location.pathname, { ...url, zone: null, home: null })}
      onReplay={() => setReplayStartMs(Date.now())}
      onZone={(zone) => {
        zoomToZone(zone)
        setUrl(readUrlState())
      }}
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
      onBack={() => {
        const next = { ...readUrlState(), zone: null, home: null }
        writeUrlState(next, { push: true })
        setUrl(next)
      }}
    />
  )
}
