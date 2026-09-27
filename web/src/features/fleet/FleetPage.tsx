import {
  STATUS_FILTERS,
  ZONE_FILTERS,
  ackClass,
  ackText,
  chargeClass,
  chargeStateClass,
  chargeStateText,
  filterText,
  formatSeen,
  powerText,
  quantity,
  statusClass,
  zoneLabel,
  zoneText,
} from "./display"
import { homeName } from "../replay/homeName"
import type { FleetPageProps, Home } from "./types"
import "./fleet.css"

function lastAck(home: Home) {
  if (home.last_command === null) {
    return null
  }
  return home.last_command.ack
}

/** Row numbers for a range of many homes; a single home is always named (homeName, Task 17). */
function rangeText(offset: number, homes: Home[]): string {
  if (homes.length === 0) return "No homes"
  if (homes.length === 1) return homeName(homes[0])
  return `Homes ${offset + 1}–${offset + homes.length}`
}

export function FleetPage({
  homes,
  statusFilter,
  zoneFilter,
  query,
  offset,
  limit,
  hasMore,
  onFilter,
  onZone,
  onQuery,
  onPage,
  onOpenHome,
}: FleetPageProps) {
  const windowed = homes.slice(0, limit)
  return (
    <main className="fleet-page">
      <header className="fleet-mast">
        <a className="fleet-button" href="/">
          Wall
        </a>
        <h1 className="fleet-title">Fleet</h1>
        <p className="fleet-kicker">
          Zone <span className="fleet-filter-value">{zoneText(zoneFilter)}</span>
          {" · "}
          Status <span className="fleet-filter-value">{filterText(statusFilter)}</span>
        </p>
      </header>
      <div className="fleet-filters" role="group" aria-label="Zone filter">
        {ZONE_FILTERS.map((zone) => {
          const pressed = zone === zoneFilter
          const className = pressed ? "fleet-button fleet-button-on" : "fleet-button"
          return (
            <button
              key={zone}
              type="button"
              className={className}
              aria-pressed={pressed}
              onClick={() => onZone(zone)}
            >
              {zoneText(zone)}
            </button>
          )
        })}
      </div>
      <div className="fleet-filters" role="group" aria-label="Status filter">
        {STATUS_FILTERS.map((status) => {
          const pressed = status === statusFilter
          const className = pressed ? "fleet-button fleet-button-on" : "fleet-button"
          return (
            <button
              key={status}
              type="button"
              className={className}
              aria-pressed={pressed}
              onClick={() => onFilter(status)}
            >
              {filterText(status)}
            </button>
          )
        })}
      </div>
      <div className="fleet-toolbar">
        <label className="fleet-search-label">
          Search
          <input
            className="fleet-search"
            type="search"
            value={query}
            aria-label="Search home id"
            placeholder="home-001"
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
        <p className="fleet-count">{rangeText(offset, windowed)}</p>
        <div className="fleet-pager" role="group" aria-label="Page">
          <button
            type="button"
            className="fleet-button"
            disabled={offset === 0}
            onClick={() => onPage(Math.max(0, offset - limit))}
          >
            Previous
          </button>
          <button
            type="button"
            className="fleet-button"
            disabled={!hasMore}
            onClick={() => onPage(offset + limit)}
          >
            Next
          </button>
        </div>
      </div>
      <div className="fleet-scroll">
        <table className="fleet-table">
          <thead>
            <tr>
              <th scope="col">Home</th>
              <th scope="col">Zone</th>
              <th scope="col">Status</th>
              <th scope="col">State of charge</th>
              <th scope="col">Floor</th>
              <th scope="col">Kilowatts assigned this tick</th>
              <th scope="col">Charge state</th>
              <th scope="col">Power</th>
              <th scope="col">Last seen</th>
              <th scope="col">Last ack</th>
            </tr>
          </thead>
          <tbody>
            {windowed.length === 0 ? (
              <tr>
                <td className="fleet-empty" colSpan={10}>
                  No homes
                </td>
              </tr>
            ) : (
              windowed.map((home) => {
                const ack = lastAck(home)
                return (
                  <tr
                    key={home.home_id}
                    className="fleet-row"
                    onClick={() => onOpenHome(home.home_id)}
                  >
                    <th scope="row">
                      <button
                        type="button"
                        className="fleet-open"
                        onClick={(event) => {
                          event.stopPropagation()
                          onOpenHome(home.home_id)
                        }}
                      >
                        {homeName(home)}
                      </button>
                    </th>
                    <td>{zoneLabel(home.zone)}</td>
                    <td className={statusClass(home.status)}>{home.status}</td>
                    <td className={chargeClass(home.soc_kwh, home.floor_kwh)}>
                      {quantity(home.soc_kwh)}
                      <span className="fleet-unit">kWh</span>
                    </td>
                    <td>
                      {quantity(home.floor_kwh)}
                      <span className="fleet-unit">kWh</span>
                    </td>
                    <td>
                      {quantity(home.assigned_kw)}
                      <span className="fleet-unit">kW</span>
                    </td>
                    <td className={chargeStateClass(home.charge_state)}>{chargeStateText(home.charge_state)}</td>
                    <td className={home.power_kw === null ? "fleet-tone-muted" : undefined}>
                      {powerText(home.power_kw)}
                      {home.power_kw === null ? null : <span className="fleet-unit">kW</span>}
                    </td>
                    <td>{formatSeen(home.last_seen)}</td>
                    <td className={ackClass(ack)}>{ackText(ack)}</td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </main>
  )
}
