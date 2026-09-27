import { useEffect, useMemo, useRef, useState } from "react"
import { apiBaseUrl } from "../../api/health"
import { fetchState } from "../flow/api"
import { isWorkerDown } from "../flow/types"
import { FleetGridPage } from "./FleetGridPage"
import {
  LIVE_LIMIT, defaultSource, errorText, findHome, focusZoneFromSearch, fromLiveRows, fromScenarioHomes, liveFleetNote,
  readHomesSource, readSplit, scenarioFleetNote, splitSearch, toggleSplit,
  type CountyRosterRow, type FilterKey, type GridHome, type SourceKey,
} from "./fleetModel"

const TIMEOUT_MS = 3000
const POLL_MS: Record<SourceKey, number> = { live: 15_000, scenario: 1_000 }

type Loaded = { homes: GridHome[]; note: string; counties: CountyRosterRow[] }

function rosterRows(body: unknown): CountyRosterRow[] {
  if (!Array.isArray(body)) return []
  return body.filter((r): r is CountyRosterRow =>
    typeof r === "object" && r !== null && typeof r.zone === "string" && typeof r.fips === "string" && typeof r.name === "string")
}

// The county roster for the live source. Missing (older API) is an empty roster, so counties come from the rows.
async function loadRoster(base: string): Promise<CountyRosterRow[]> {
  try {
    const res = await fetch(`${base}/v1/fleet/counties`, {
      cache: "no-store", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return res.ok ? rosterRows(await res.json()) : []
  } catch {
    return []
  }
}

// Own fetch, not createClient().homes: its strict parseHome throws on one row with a missing number and
// drops the whole list, where this page must keep the row and show "Not reported".
async function loadLive(base: string): Promise<Loaded> {
  const res = await fetch(`${base}/v1/homes?limit=${LIVE_LIMIT}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      // Keep the bare status when the body is not JSON.
    }
    throw new Error(errorText(res.status, body))
  }
  const body: unknown = await res.json()
  if (!Array.isArray(body)) throw new Error("the reply was not a list of homes")
  const homes = fromLiveRows(body)
  // X-Homes-Source says whether these are the Supabase fleet or the 3-row console sample.
  const src = readHomesSource(res.headers)
  const counties = src.source === "fixture" ? [] : await loadRoster(base)
  return { homes, note: liveFleetNote(src, body.length), counties }
}

async function loadScenario(base: string): Promise<Loaded> {
  const reply = await fetchState(fetch, base)
  if (isWorkerDown(reply)) throw new Error(`scenario worker not running. ${reply.brief}`)
  const homes = fromScenarioHomes(Array.isArray(reply.homes) ? reply.homes : [])
  return { homes, note: scenarioFleetNote(reply, homes.length), counties: rosterRows(reply.counties) }
}

/** Scenario when the worker answers, otherwise Live. */
async function pickSource(base: string): Promise<SourceKey> {
  try {
    return defaultSource(await fetchState(fetch, base))
  } catch {
    return "live"
  }
}

function message(err: unknown): string {
  if (err instanceof Error) return err.name === "TimeoutError" ? "the API did not answer in 3 s" : err.message
  return "unknown error"
}

export function FleetGridRoot() {
  const base = useMemo(() => apiBaseUrl(), [])
  const focusZone = useMemo(() => focusZoneFromSearch(window.location.search), [])
  // Null until the first look at the scenario worker picks the default; a click before that wins.
  const [source, setSource] = useState<SourceKey | null>(null)
  const [split, setSplit] = useState<Set<string>>(() => readSplit(window.location.search))
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterKey>("all")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const scrolledZone = useRef(false)

  useEffect(() => {
    document.title = "ReserveGate fleet"
  }, [])

  useEffect(() => {
    let cancelled = false
    void pickSource(base).then((picked) => {
      if (!cancelled) setSource((current) => current ?? picked)
    })
    return () => {
      cancelled = true
    }
  }, [base])

  useEffect(() => {
    if (source === null) return
    let cancelled = false
    setLoaded(null)
    setLoading(true)
    setError(null)
    // One request at a time: a tick is skipped while the last one is in flight, so an older reply
    // (up to the 3 s timeout) can never land after, and overwrite, a newer one.
    let inFlight = false
    async function poll() {
      if (inFlight) return
      inFlight = true
      try {
        const next = await (source === "live" ? loadLive(base) : loadScenario(base))
        if (cancelled) return
        setLoaded(next)
        setError(null)
      } catch (err) {
        if (!cancelled) setError(message(err))
      } finally {
        inFlight = false
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

  // The search hit follows the current query and the homes loaded now, so it is right after a load or a source switch.
  const foundId = useMemo(() => (homes === null ? null : findHome(homes, query)?.id ?? null), [homes, query])

  useEffect(() => {
    if (foundId === null) return
    Array.from(document.querySelectorAll<HTMLElement>("[data-home]"))
      .find((el) => el.dataset.home === foundId)
      ?.scrollIntoView({ block: "center", behavior: "smooth" })
  }, [foundId])

  const onSplit = (zone: string) => {
    const next = toggleSplit(split, zone)
    setSplit(next)
    // Keep the choice in ?split= so a reload keeps it. The page works the same if this fails.
    try {
      const { pathname, search, hash } = window.location
      window.history.replaceState(window.history.state, "", `${pathname}${splitSearch(search, next)}${hash}`)
    } catch {
      // No history access (sandboxed frame): the split still applies for this visit.
    }
  }

  const readingNote = source === null ? "Choosing a source" : source === "live" ? "Reading live homes" : "Reading the scenario"

  return (
    <FleetGridPage
      source={source ?? "live"}
      homes={homes}
      loading={loading}
      error={error}
      counties={loaded?.counties ?? []}
      split={split}
      onSplit={onSplit}
      sourceNote={loaded?.note ?? readingNote}
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
      }}
      onFilter={setFilter}
      onSelect={setSelectedId}
      onQuery={setQuery}
      onFind={(q) => {
        const hit = homes === null ? null : findHome(homes, q)
        if (hit) setSelectedId(hit.id)
      }}
    />
  )
}
