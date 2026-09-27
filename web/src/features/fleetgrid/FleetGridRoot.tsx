import { useEffect, useMemo, useRef, useState } from "react"
import { apiBaseUrl } from "../../api/health"
import { fetchState } from "../flow/api"
import { isWorkerDown } from "../flow/types"
import { FleetGridPage } from "./FleetGridPage"
import {
  LIVE_LIMIT, findHome, focusZoneFromSearch, fromLiveRows, fromScenarioHomes, liveSourceNote, scenarioSourceNote,
  type FilterKey, type GridHome, type SourceKey,
} from "./fleetModel"

const TIMEOUT_MS = 3000
const POLL_MS: Record<SourceKey, number> = { live: 15_000, scenario: 1_000 }

type Loaded = { homes: GridHome[]; note: string }

async function loadLive(base: string): Promise<Loaded> {
  const res = await fetch(`${base}/v1/homes?limit=${LIVE_LIMIT}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`http ${res.status}`)
  const body: unknown = await res.json()
  if (!Array.isArray(body)) throw new Error("the reply was not a list of homes")
  const homes = fromLiveRows(body)
  return { homes, note: liveSourceNote(body.length) }
}

async function loadScenario(base: string): Promise<Loaded> {
  const reply = await fetchState(fetch, base)
  if (isWorkerDown(reply)) throw new Error(`scenario worker not running. ${reply.brief}`)
  const homes = fromScenarioHomes(Array.isArray(reply.homes) ? reply.homes : [])
  return { homes, note: scenarioSourceNote(reply) }
}

function message(err: unknown): string {
  if (err instanceof Error) return err.name === "TimeoutError" ? "the API did not answer in 3 s" : err.message
  return "unknown error"
}

export function FleetGridRoot() {
  const base = useMemo(() => apiBaseUrl(), [])
  const focusZone = useMemo(() => focusZoneFromSearch(window.location.search), [])
  const [source, setSource] = useState<SourceKey>("live")
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterKey>("all")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [foundId, setFoundId] = useState<string | null>(null)
  const scrolledZone = useRef(false)

  useEffect(() => {
    document.title = "ReserveGate fleet"
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoaded(null)
    setLoading(true)
    setError(null)
    async function poll() {
      try {
        const next = await (source === "live" ? loadLive(base) : loadScenario(base))
        if (cancelled) return
        setLoaded(next)
        setError(null)
      } catch (err) {
        if (!cancelled) setError(message(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS[source])
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [base, source])

  const homes = loaded?.homes ?? null

  // Honour ?zone= once the banks exist: scroll to that bank (it is highlighted by the page).
  useEffect(() => {
    if (scrolledZone.current || focusZone === null || homes === null || homes.length === 0) return
    scrolledZone.current = true
    document.querySelector(`[data-zone="${focusZone}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" })
  }, [focusZone, homes])

  useEffect(() => {
    if (foundId === null) return
    document.querySelector(`[data-home="${CSS.escape(foundId)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" })
  }, [foundId])

  function find(q: string, open: boolean) {
    const hit = homes === null ? null : findHome(homes, q)
    setFoundId(hit?.id ?? null)
    if (open && hit) setSelectedId(hit.id)
  }

  return (
    <FleetGridPage
      source={source}
      homes={homes}
      loading={loading}
      error={error}
      sourceNote={loaded?.note ?? (source === "live" ? "Reading live homes" : "Reading the scenario")}
      filter={filter}
      selectedId={selectedId}
      foundId={foundId}
      focusZone={focusZone}
      query={query}
      onSource={(next) => {
        if (next === source) return
        setSource(next)
        setFilter("all")
        setSelectedId(null)
        setFoundId(null)
      }}
      onFilter={setFilter}
      onSelect={setSelectedId}
      onQuery={(q) => {
        setQuery(q)
        find(q, false)
      }}
      onFind={(q) => find(q, true)}
    />
  )
}
