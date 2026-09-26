import { useEffect, useState } from "react"
import { createClient } from "../../api/client"
import { apiBaseUrl } from "../../api/health"
import { FleetPage } from "./FleetPage"
import { HomePage } from "./HomePage"
import { previewHomes } from "./preview-data"
import { FLEET_PAGE_LIMIT, homesQuery, selectedZoneFromSearch } from "./query"
import type { Home, StatusFilter, ZoneFilter } from "./types"

export function FleetApp() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [zoneFilter, setZoneFilter] = useState<ZoneFilter>(
    () => selectedZoneFromSearch(window.location.search) ?? "all",
  )
  const [query, setQuery] = useState("")
  const [offset, setOffset] = useState(0)
  const [homes, setHomes] = useState<Home[]>([])
  const [openHomeId, setOpenHomeId] = useState<string | null>(null)

  useEffect(() => {
    document.title = "ReserveGate fleet"
  }, [])

  useEffect(() => {
    let cancelled = false
    const client = createClient({
      fetch: window.fetch.bind(window),
      baseUrl: `${apiBaseUrl()}/v1`,
      operatorId: "operator-demo",
    })
    void client
      .homes(homesQuery({ zone: zoneFilter, status: statusFilter, q: query, offset }))
      .then((rows) => {
        if (!cancelled) setHomes(rows)
      })
      .catch(() => {
        if (!cancelled) setHomes(previewHomes.slice(0, FLEET_PAGE_LIMIT))
      })
    return () => {
      cancelled = true
    }
  }, [zoneFilter, statusFilter, query, offset])

  const openHome = homes.find((home) => home.home_id === openHomeId) ?? null
  if (openHome !== null) {
    return <HomePage home={openHome} onBack={() => setOpenHomeId(null)} />
  }

  return (
    <FleetPage
      homes={homes}
      statusFilter={statusFilter}
      zoneFilter={zoneFilter}
      query={query}
      offset={offset}
      limit={FLEET_PAGE_LIMIT}
      hasMore={homes.length === FLEET_PAGE_LIMIT}
      onFilter={(status) => {
        setStatusFilter(status)
        setOffset(0)
      }}
      onZone={(zone) => {
        setZoneFilter(zone)
        setOffset(0)
      }}
      onQuery={(next) => {
        setQuery(next)
        setOffset(0)
      }}
      onPage={setOffset}
      onOpenHome={setOpenHomeId}
    />
  )
}
