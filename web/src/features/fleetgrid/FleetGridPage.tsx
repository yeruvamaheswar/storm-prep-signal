import { BankPanel } from "./BankPanel"
import { FleetLegend } from "./FleetLegend"
import { HomeDetail } from "./HomeDetail"
import { Skeleton } from "./Skeleton"
import {
  FILTERS, filterCounts, floorLegend, homesTitle, otherNote, zoneBanks,
  type CountyRosterRow, type FilterKey, type GridHome, type SourceKey,
} from "./fleetModel"
import "./fleetgrid.css"

export type FleetGridPageProps = {
  /** Null while the source is still being picked: then neither source button reads as selected. */
  source: SourceKey | null
  /** Null until the first load for this source answers. */
  homes: GridHome[] | null
  loading: boolean
  error: string | null
  sourceNote: string
  filter: FilterKey
  selectedId: string | null
  foundId: string | null
  /** Zone from ?zone=, highlighted. */
  focusZone: string | null
  query: string
  onSource: (source: SourceKey) => void
  onFilter: (filter: FilterKey) => void
  onSelect: (id: string | null) => void
  onQuery: (query: string) => void
  onFind: (query: string) => void
  /** Task 13 item 7: the county roster (GET /v1/fleet/counties or the scenario's `counties`). */
  counties?: CountyRosterRow[]
  /** Regions shown split by county. */
  split?: ReadonlySet<string>
  onSplit?: (zone: string) => void
}

const SOURCES: Array<[SourceKey, string]> = [["live", "Live"], ["scenario", "Scenario"]]

export const FLEET_NOTE =
  "Batteries are simulated. The fill is each battery's real charge from the engine; the dashed line is the floor it keeps for backup."

export function FleetGridPage(props: FleetGridPageProps) {
  const { source, homes, loading, error, sourceNote, filter, selectedId, foundId, focusZone, query } = props
  const counts = homes === null ? null : filterCounts(homes)
  const other = homes === null ? null : otherNote(homes)
  const selected = homes?.find((h) => h.id === selectedId) ?? null

  let body
  if (homes === null && error !== null) {
    body = <p className="fg-status is-error" role="alert">Could not load homes: {error}</p>
  } else if (homes === null) {
    body = loading ? <Skeleton /> : <p className="fg-status">Waiting for homes</p>
  } else if (homes.length === 0) {
    body = <p className="fg-status">No homes</p>
  } else {
    body = (
      <div className="fg-banks">
        {zoneBanks(homes, props.counties ?? []).map((bank) => (
          <BankPanel
            key={bank.key}
            bank={bank}
            filter={filter}
            focused={bank.zone !== null && bank.zone === focusZone}
            selectedId={selectedId}
            foundId={foundId}
            onSelect={props.onSelect}
            split={props.split?.has(bank.key) ?? false}
            onSplit={props.onSplit}
          />
        ))}
      </div>
    )
  }

  return (
    <main className={selected ? "fg-scene has-detail" : "fg-scene"}>
      <section className="fg-panel fg-controls" aria-label="Fleet controls">
        <div className="fg-title">
          <h1>{homes === null ? "Fleet" : homesTitle(homes.length)}</h1>
          <p>{sourceNote}</p>
        </div>
        <div className="fg-seg" role="group" aria-label="Source">
          {SOURCES.map(([key, label]) => (
            <button key={key} type="button" className={source === key ? "on" : undefined} aria-pressed={source === key} onClick={() => props.onSource(key)}>
              {label}
            </button>
          ))}
        </div>
        <div className="fg-seg" role="group" aria-label="Show homes">
          {FILTERS.map(([key, label]) => (
            <button key={key} type="button" className={filter === key ? "on" : undefined} aria-pressed={filter === key} onClick={() => props.onFilter(key)}>
              {counts === null ? label : `${label} ${counts[key]}`}
            </button>
          ))}
        </div>
        {other === null ? null : <span className="fg-other">{other}</span>}
        <form
          className="fg-find"
          role="search"
          onSubmit={(e) => {
            e.preventDefault()
            props.onFind(query)
          }}
        >
          <label>
            Find a home
            <input className="fg-q" type="search" placeholder="home-066" value={query} onChange={(e) => props.onQuery(e.target.value)} />
          </label>
        </form>
      </section>

      {homes !== null && error !== null ? (
        <p className="fg-status is-error" role="alert">Last refresh failed: {error}. Showing the last homes loaded.</p>
      ) : null}

      {body}

      <FleetLegend floorText={floorLegend(homes ?? [])} />
      <p className="fg-note">{FLEET_NOTE}</p>

      {selected ? <HomeDetail home={selected} onClose={() => props.onSelect(null)} /> : null}
    </main>
  )
}
