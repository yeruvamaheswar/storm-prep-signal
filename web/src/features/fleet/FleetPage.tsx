import {
  STATUS_FILTERS,
  ackClass,
  ackText,
  chargeClass,
  filterText,
  formatSeen,
  quantity,
  statusClass,
} from "./display"
import type { FleetPageProps, Home } from "./types"
import "./fleet.css"

function lastAck(home: Home) {
  if (home.last_command === null) {
    return null
  }
  return home.last_command.ack
}

export function FleetPage({ homes, statusFilter, onFilter, onOpenHome }: FleetPageProps) {
  return (
    <main className="fleet-page">
      <header className="fleet-mast">
        <h1 className="fleet-title">Fleet</h1>
        <p className="fleet-kicker">
          Active filter <span className="fleet-filter-value">{filterText(statusFilter)}</span>
        </p>
      </header>
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
      <p className="fleet-count">{homes.length === 1 ? "1 home" : `${homes.length} homes`}</p>
      <div className="fleet-scroll">
        <table className="fleet-table">
          <thead>
            <tr>
              <th scope="col">Home</th>
              <th scope="col">Status</th>
              <th scope="col">State of charge</th>
              <th scope="col">Floor</th>
              <th scope="col">Kilowatts assigned this tick</th>
              <th scope="col">Last seen</th>
              <th scope="col">Last ack</th>
            </tr>
          </thead>
          <tbody>
            {homes.length === 0 ? (
              <tr>
                <td className="fleet-empty" colSpan={7}>
                  No homes
                </td>
              </tr>
            ) : (
              homes.map((home) => {
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
                        {home.home_id}
                      </button>
                    </th>
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
