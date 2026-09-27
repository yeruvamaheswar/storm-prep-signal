import type { FleetRollups, TickView } from "../../contracts"
import { isLoadZone, type LoadZone } from "../../zonePaint"
import { Button } from "../atoms/Button"
import { Key } from "../atoms/Key"
import { ackSummary, barSegments, totalsToMarks, zoneAckTotals } from "./ackTicks"
import { telemetryLine } from "./telemetryLine"

type AckRailProps = {
  tick: TickView
  zone?: LoadZone | null
  rollups?: FleetRollups | null
  onSelectZone?: (zone: LoadZone) => void
  onClearZone?: () => void
}

/** Stacked bars from snapshot zone_acks. One bar per zone, never one span per home. */
export function AckRail({ tick, zone = null, rollups = null, onSelectZone, onClearZone }: AckRailProps) {
  const rows = zoneAckTotals(tick, rollups)
  const marks = totalsToMarks(rows)
  const battery = telemetryLine(tick)

  return (
    <section className="ack-rail" aria-label="Worker acks">
      <div className="ack-rail-head">
        <Key>Worker acks</Key>
        <Button pressed={zone === null} label="Show every load zone" onClick={() => onClearZone?.()}>
          All zones
        </Button>
        <p className="ack-caption" role="status">
          {ackSummary(marks, tick.delivered_mw)}
        </p>
        {battery && (
          <p className="telemetry-line">
            Battery reports: {battery.live} ·{" "}
            {/* Red only when a battery's reports disagree with its energy; 0 stays muted. */}
            <span className={battery.suspect > 0 ? "telemetry-suspect is-flagged" : "telemetry-suspect"}>
              {battery.suspect} suspect
            </span>{" "}
            · {battery.readings} (synthetic)
          </p>
        )}
      </div>
      <div className="ack-zones">
        {rows.map((row) => {
          const selected = zone === row.zone
          const segments = barSegments(row)
          const label = `${row.zone} ${row.acked}/${row.homes}`
          return (
            <button
              key={row.zone}
              type="button"
              className={selected ? "ack-zone is-selected" : "ack-zone"}
              aria-pressed={selected}
              onClick={() => {
                if (isLoadZone(row.zone)) onSelectZone?.(row.zone)
              }}
            >
              <span className="label">{label}</span>
              <div
                className="ack-bar"
                role="img"
                aria-label={`${row.zone} ${row.acked} acked, ${row.held} held, ${row.silent} silent, ${row.unconfirmed} unconfirmed, ${row.dead} dead`}
              >
                {segments.map(({ mark, count }) => (
                  <span
                    key={mark}
                    className={`ack-seg ack-${mark}`}
                    style={{ flexGrow: count }}
                    data-state={mark}
                    title={`${row.zone} · ${mark} · ${count}`}
                  />
                ))}
              </div>
            </button>
          )
        })}
      </div>
    </section>
  )
}
