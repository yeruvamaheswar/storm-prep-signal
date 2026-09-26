import { ackClass, ackText, chargeClass, formatSeen, quantity, skipClass, skipText, statusClass } from "./display"
import type { HomePageProps } from "./types"
import "./fleet.css"

export function HomePage({ home, onBack }: HomePageProps) {
  const command = home.last_command
  const ack = command === null ? null : command.ack

  return (
    <main className="fleet-page">
      <header className="fleet-mast">
        <button type="button" className="fleet-button" onClick={onBack}>
          Back
        </button>
        <h1 className="fleet-title">{home.home_id}</h1>
      </header>
      <section className="fleet-strip" aria-label="Home readings">
        <div>
          <span className="fleet-key">Capacity</span>
          <p className="fleet-metric-value">
            {quantity(home.capacity_kwh)}
            <span className="fleet-unit">kWh</span>
          </p>
        </div>
        <div>
          <span className="fleet-key">Charge</span>
          <p className={`fleet-metric-value ${chargeClass(home.soc_kwh, home.floor_kwh)}`}>
            {quantity(home.soc_kwh)}
            <span className="fleet-unit">kWh</span>
          </p>
        </div>
        <div>
          <span className="fleet-key">Floor</span>
          <p className="fleet-metric-value">
            {quantity(home.floor_kwh)}
            <span className="fleet-unit">kWh</span>
          </p>
        </div>
        <div>
          <span className="fleet-key">Max</span>
          <p className="fleet-metric-value">
            {quantity(home.max_kw)}
            <span className="fleet-unit">kW</span>
          </p>
        </div>
        <div>
          <span className="fleet-key">Assigned</span>
          <p className="fleet-metric-value">
            {quantity(home.assigned_kw)}
            <span className="fleet-unit">kW</span>
          </p>
        </div>
      </section>
      <dl className="fleet-facts">
        <div>
          <dt className="fleet-key">Status</dt>
          <dd className={statusClass(home.status)}>{home.status}</dd>
        </div>
        <div>
          <dt className="fleet-key">Eligible</dt>
          <dd>{home.eligible ? "yes" : "no"}</dd>
        </div>
        <div>
          <dt className="fleet-key">skip_reason</dt>
          <dd className={skipClass(home.skip_reason)}>{skipText(home.skip_reason)}</dd>
        </div>
        <div>
          <dt className="fleet-key">Last seen</dt>
          <dd>{formatSeen(home.last_seen)}</dd>
        </div>
      </dl>
      <section className="fleet-command" aria-label="Last command">
        <h2>Last command</h2>
        {command === null ? (
          <p className="fleet-metric-value fleet-tone-muted">none</p>
        ) : (
          <>
            <p className="fleet-metric-value">
              {quantity(command.kw)}
              <span className="fleet-unit">kW</span>
            </p>
            <p className="fleet-sent">{formatSeen(command.sent_at)}</p>
          </>
        )}
        <p className="fleet-ack">
          <span className="fleet-key">Ack</span>
          <span className={ackClass(ack)}>{ackText(ack)}</span>
        </p>
      </section>
    </main>
  )
}
